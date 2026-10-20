// The Keycloak handshake end to end in a real browser (feature-specs/09 § 14.5; 08 § 12.4, § 12.7, § 12.9):
// sign in with "Google", link "GitHub", role mirroring, RP-initiated sign-out, back-channel logout.
// Needs: the dev server (`npm run dev`, with KEYCLOAK_* in .env), Keycloak (`npm run auth:kc`) and the
// stand-in realm (`npm run auth:kc:fake`). Exits non-zero on the first failed assertion.
//
//   npm run auth:kc:walk        # APP_URL, KEYCLOAK_URL, KC_ADMIN, KC_ADMIN_PASSWORD, PW_CHANNEL optional
import { chromium } from "@playwright/test";

const app = process.env.APP_URL ?? "http://localhost:3000";
const kc = process.env.KEYCLOAK_URL ?? "http://localhost:8081";
const ADMIN = process.env.KC_ADMIN ?? "admin";
const ADMIN_PASSWORD = process.env.KC_ADMIN_PASSWORD ?? "admin";
const USER = "reader@example.test";
const PASS = "reader-pass-1";
const launch = process.env.PW_CHANNEL === undefined ? { headless: true } : { channel: process.env.PW_CHANNEL, headless: true };

const log = (...a) => console.log(a.join(" "));
const clean = (s) => (s ?? "").replace(/<!-- -->/g, "").replace(/\s+/g, " ").trim();
function check(condition, what) {
  if (!condition) {
    console.error(`FAILED: ${what}`);
    process.exitCode = 1;
    throw new Error(what);
  }
  log("ok  ", what);
}

const browser = await chromium.launch(launch);
const errors = [];
function watch(page) {
  page.setDefaultNavigationTimeout(120000);
  page.setDefaultTimeout(45000);
  page.on("console", (m) => { if (m.type() === "error" && !m.text().startsWith("Failed to load resource")) errors.push(m.text()); });
}

/** Fill the stand-in realm's form (fresh login or re-authentication) and wait to land back on the application. */
async function standIn(page) {
  await page.waitForSelector("input[name=password]", { timeout: 60000 });
  if (await page.locator("input[name=username]:not([readonly])").count()) await page.fill("input[name=username]", USER);
  await page.fill("input[name=password]", PASS);
  await Promise.all([page.waitForURL((u) => u.origin === app, { timeout: 90000 }), page.click("#kc-login")]);
}

async function adminToken() {
  const r = await fetch(`${kc}/realms/master/protocol/openid-connect/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "password", client_id: "admin-cli", username: ADMIN, password: ADMIN_PASSWORD }) });
  if (!r.ok) throw new Error(`admin token: ${r.status}`);
  return (await r.json()).access_token;
}
async function admin(method, path, body) {
  const t = await adminToken();
  const r = await fetch(`${kc}/admin/realms${path}`, { method, headers: { authorization: `Bearer ${t}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  return { status: r.status, body: text.length === 0 ? null : JSON.parse(text) };
}
const brokered = async () => ((await admin("GET", `/harness-bible/users?email=${encodeURIComponent(USER)}&exact=true`)).body ?? [])[0];
const facts = async (page) => (await page.locator(".account-facts dd").allTextContents()).map(clean);

try {
  // a clean slate at the broker: the brokered user of a previous run goes; the application adopts by e-mail
  {
    const u = await brokered();
    if (u !== undefined) await admin("DELETE", `/harness-bible/users/${u.id}`);
    log("setup: brokered user", u === undefined ? "absent" : "removed");
  }

  // 1. sign-in page → Continue with Google → Keycloak (hint honoured) → stand-in form → callback → the section
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await ctx.newPage();
  watch(page);
  await page.goto(`${app}/en/login?next=/en/ch/21/21.3`, { waitUntil: "load" });
  check((await page.locator('.auth a.btn[href*="idp=google"]').count()) === 1 && (await page.locator('.auth a.btn[href*="idp=github"]').count()) === 1, "1a the sign-in page offers Google and GitHub as plain anchors");
  const [loginResp] = await Promise.all([page.waitForResponse((r) => r.url().includes("/api/v1/auth/login")), page.locator('.auth a.btn[href*="idp=google"]').click()]);
  check(loginResp.status() === 302 && (loginResp.headers()["location"] ?? "").startsWith(`${kc}/realms/harness-bible/protocol/openid-connect/auth?`), "1b the login route redirects to Keycloak's authorization endpoint");
  await page.waitForSelector("input[name=password]", { timeout: 60000 });
  check(page.url().includes("/realms/fake-idp/"), "1c kc_idp_hint skipped Keycloak's chooser and reached the provider");
  await standIn(page);
  check(page.url() === `${app}/en/ch/21/21.3`, `1d landed on next (${page.url()})`);
  check(clean(await page.locator(".topbar-account").textContent()) === "Account", "1e the top bar shows Account");
  const cookies = (await ctx.cookies()).filter((c) => c.name.startsWith("hb."));
  check(cookies.length === 1 && cookies[0].name === "hb.session" && cookies[0].httpOnly, "1f one HttpOnly hb.session cookie and no handshake cookie left");

  // 2. the account page: provider, role and the name from the id token
  await page.goto(`${app}/en/account`, { waitUntil: "load" });
  const f2 = await facts(page);
  check(f2[1] === "google" && f2[2].endsWith("· reader"), `2a facts read google · reader (${f2.join(" | ")})`);
  check((await page.locator("#identities li").count()) === 1 && clean(await page.locator("#identities a.btn").textContent()) === "Link GitHub", "2b one identity and a Link GitHub anchor");
  check(clean(await page.locator("h1").textContent()) === "Reader One", "2c the display name came from the provider");

  // 3. link GitHub: prompt=login → the stand-in asks again → Keycloak links by verified e-mail → ?linked=github
  await page.locator('#identities a.btn[href*="idp=github"]').click();
  await page.waitForSelector("input[name=password], .account-facts", { timeout: 60000 });
  check((await page.locator("input[name=password]").count()) === 1, "3a linking re-authenticates at the provider");
  await standIn(page);
  await page.locator(".account-facts").waitFor();
  check(page.url().endsWith("/en/account?linked=github"), `3b back on the account page with ?linked=github (${page.url()})`);
  check((await page.locator("#identities li").count()) === 2 && (await facts(page))[1] === "googlegithub" && (await page.locator("#identities form .btn").count()) === 2, "3c two identities, both unlinkable");

  // 4. role mirroring: hb_role=builder at Keycloak → the next sign-in is BUILDER and revokes the other sessions
  {
    const user = await brokered();
    const r = await admin("PUT", `/harness-bible/users/${user.id}`, { ...user, attributes: { ...(user.attributes ?? {}), hb_role: ["builder"], identity_verified: ["true"] } });
    check(r.status === 204, "4a hb_role=builder set at Keycloak");
  }
  const second = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const p2 = await second.newPage();
  watch(p2);
  await p2.goto(`${app}/api/v1/auth/login?idp=google&next=/en/account`, { waitUntil: "load" });
  await standIn(p2);
  await p2.locator(".account-facts").waitFor();
  check((await facts(p2))[2].endsWith("· builder") && (await p2.locator(".sessions-table tbody tr").count()) === 1, "4b the second browser is builder with one session");
  await page.goto(`${app}/en/account`, { waitUntil: "load" });
  check(page.url().startsWith(`${app}/en/login?next=`), "4c the first browser's session was revoked by the role change");

  // 5. RP-initiated sign-out with id_token_hint: no confirmation page, straight back to the application
  await p2.goto(`${app}/en/logout`, { waitUntil: "load" });
  const [outResp] = await Promise.all([p2.waitForResponse((r) => r.url().includes("/api/v1/auth/logout")), p2.locator(".auth form").first().locator("button").click()]);
  const loc = outResp.headers()["location"] ?? "";
  check(outResp.status() === 302 && loc.startsWith(`${kc}/realms/harness-bible/protocol/openid-connect/logout?`) && loc.includes("id_token_hint=") && loc.includes("client_id=hb-web"), "5a the logout route redirects to Keycloak's end-session endpoint with id_token_hint");
  await p2.waitForURL(`${app}/en`, { timeout: 45000 });
  check(true, "5b Keycloak returned to the application without a confirmation page");
  check(!(await second.cookies()).some((c) => c.name === "hb.session" && c.value.length > 0), "5c the session cookie is gone");
  await p2.goto(`${app}/api/v1/auth/login?idp=google&next=/en`, { waitUntil: "load" });
  await p2.waitForSelector("input[name=password], .topbar-account", { timeout: 60000 });
  check((await p2.locator("input[name=password]").count()) === 1, "5d a new sign-in asks for credentials again (the broker session ended)");
  await second.close();

  // 6. back-channel logout: an admin logout at Keycloak reaches POST /api/v1/auth/backchannel-logout and removes the rows
  {
    const ctx3 = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const p3 = await ctx3.newPage();
    watch(p3);
    await p3.goto(`${app}/api/v1/auth/login?idp=google&next=/en/account`, { waitUntil: "load" });
    await standIn(p3);
    await p3.locator(".account-facts").waitFor();
    check((await p3.locator(".sessions-table tbody tr").count()) === 1, "6a signed in again with one session");
    const user = await brokered();
    const r = await admin("POST", `/harness-bible/users/${user.id}/logout`);
    check(r.status === 204, "6b admin logout at Keycloak");
    await p3.waitForTimeout(3000);
    await p3.goto(`${app}/en/account`, { waitUntil: "load" });
    check(p3.url().startsWith(`${app}/en/login?next=`), "6c the application session was removed by the back-channel logout");
    await ctx3.close();
  }
  await ctx.close();
  check(errors.length === 0, `no console errors (${errors.slice(0, 3).join(" || ")})`);
  log("Keycloak walk passed");
} finally {
  await browser.close();
}
