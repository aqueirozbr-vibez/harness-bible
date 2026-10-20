// Points the `google` and `github` identity providers of realm `harness-bible` at a second
// realm `fake-idp` with a password user, so the whole brokered handshake runs without Google
// or GitHub credentials (feature-specs/09 § 8.8; infra/keycloak/README.md). Development and
// CI only: it talks to the admin API with the bootstrap admin. Idempotent.
//
//   node infra/keycloak/fake-idp.mjs            # KEYCLOAK_URL, KC_ADMIN, KC_ADMIN_PASSWORD, APP_URL optional

const KC = process.env.KEYCLOAK_URL ?? "http://localhost:8081";
const ADMIN = process.env.KC_ADMIN ?? "admin";
const ADMIN_PASSWORD = process.env.KC_ADMIN_PASSWORD ?? "admin";
const REALM = "harness-bible";
const FAKE = "fake-idp";
const USERS = [
  { username: "reader@example.test", email: "reader@example.test", firstName: "Reader", lastName: "One", password: "reader-pass-1" },
  { username: "second@example.test", email: "second@example.test", firstName: "Second", lastName: "Person", password: "second-pass-2" },
];

async function adminToken() {
  const res = await fetch(`${KC}/realms/master/protocol/openid-connect/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "password", client_id: "admin-cli", username: ADMIN, password: ADMIN_PASSWORD }),
  });
  if (!res.ok) throw new Error(`admin token: ${res.status} ${await res.text()}`);
  return (await res.json()).access_token;
}

const token = await adminToken();
async function api(method, path, body) {
  const res = await fetch(`${KC}/admin/realms${path}`, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  if (res.status === 404) return null;
  if (!res.ok && res.status !== 409) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`);
  const text = await res.text();
  return text.length === 0 ? null : JSON.parse(text);
}

// 1. The stand-in realm with password login and two users.
if ((await api("GET", `/${FAKE}`)) === null) {
  await api("POST", "", { realm: FAKE, enabled: true, displayName: "Stand-in identity provider (dev/CI)", registrationAllowed: false, loginWithEmailAllowed: true, sslRequired: "none" });
  console.log(`realm ${FAKE} created`);
}
for (const u of USERS) {
  const found = await api("GET", `/${FAKE}/users?username=${encodeURIComponent(u.username)}&exact=true`);
  if (found.length === 0) {
    await api("POST", `/${FAKE}/users`, { username: u.username, email: u.email, emailVerified: true, enabled: true, firstName: u.firstName, lastName: u.lastName, credentials: [{ type: "password", value: u.password, temporary: false }] });
    console.log(`user ${u.username} created`);
  }
}

// 2. One confidential client per brokered provider in the stand-in realm.
const clients = {};
for (const alias of ["google", "github"]) {
  const clientId = `hb-broker-${alias}`;
  const existing = await api("GET", `/${FAKE}/clients?clientId=${clientId}`);
  let client = existing[0];
  const representation = {
    clientId,
    enabled: true,
    protocol: "openid-connect",
    publicClient: false,
    standardFlowEnabled: true,
    directAccessGrantsEnabled: false,
    redirectUris: [`${KC}/realms/${REALM}/broker/${alias}/endpoint`],
    webOrigins: ["+"],
    /* the broker chains a front-channel logout to this realm and expects to come back to .../endpoint/logout_response */
    attributes: { "post.logout.redirect.uris": `${KC}/realms/${REALM}/broker/${alias}/endpoint/logout_response` },
  };
  if (client === undefined) {
    await api("POST", `/${FAKE}/clients`, representation);
    client = (await api("GET", `/${FAKE}/clients?clientId=${clientId}`))[0];
    console.log(`client ${clientId} created`);
  } else {
    await api("PUT", `/${FAKE}/clients/${client.id}`, { ...client, ...representation });
  }
  const secret = await api("GET", `/${FAKE}/clients/${client.id}/client-secret`);
  clients[alias] = { clientId, secret: secret.value };
}

// 3. Rewire the two identity providers of harness-bible to the stand-in realm (generic OIDC).
const issuer = `${KC}/realms/${FAKE}`;
for (const alias of ["google", "github"]) {
  const current = await api("GET", `/${REALM}/identity-provider/instances/${alias}`);
  const representation = {
    alias,
    displayName: alias === "google" ? "Google (stand-in)" : "GitHub (stand-in)",
    providerId: "oidc",
    enabled: true,
    trustEmail: true,
    storeToken: false,
    linkOnly: false,
    hideOnLogin: false,
    firstBrokerLoginFlowAlias: "hb-first-broker",
    config: {
      issuer,
      authorizationUrl: `${issuer}/protocol/openid-connect/auth`,
      tokenUrl: `${issuer}/protocol/openid-connect/token`,
      jwksUrl: `${issuer}/protocol/openid-connect/certs`,
      userInfoUrl: `${issuer}/protocol/openid-connect/userinfo`,
      logoutUrl: `${issuer}/protocol/openid-connect/logout`,
      useJwksUrl: "true",
      validateSignature: "true",
      clientId: clients[alias].clientId,
      clientSecret: clients[alias].secret,
      clientAuthMethod: "client_secret_post",
      defaultScope: "openid email profile",
      syncMode: "IMPORT",
      pkceEnabled: "true",
      pkceMethod: "S256",
    },
  };
  if (current === null) {
    await api("POST", `/${REALM}/identity-provider/instances`, representation);
    console.log(`identity provider ${alias} created (stand-in)`);
  } else {
    /* update in place: deleting and recreating the provider leaves Keycloak's user cache pointing at the old one, and brokered users then fail their next sign-in */
    await api("PUT", `/${REALM}/identity-provider/instances/${alias}`, { ...current, ...representation, internalId: current.internalId, config: { ...current.config, ...representation.config } });
    console.log(`identity provider ${alias} rewired to ${issuer}`);
  }
}

// 4. Report what the application will see.
const wk = await (await fetch(`${KC}/realms/${REALM}/.well-known/openid-configuration`)).json();
console.log(`issuer ${wk.issuer}; stand-in users: ${USERS.map((u) => `${u.username} / ${u.password}`).join(", ")}`);
