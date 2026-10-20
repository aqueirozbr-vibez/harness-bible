# Rego tests per role × action × kind for Phase 1, cross-tenant and agent identity
# (feature-specs/09 § 5.2, § 14.2). `npm run policy:test`.
package hb.authz_test

import data.hb.authz

anon := {"kind": "anonymous", "id": null, "role": null, "organisationId": null, "verified": false, "parts": [], "sessionId": null}

reader := {"kind": "user", "id": "u-reader", "role": "READER", "organisationId": null, "verified": false, "parts": [], "sessionId": "s1"}

other := {"kind": "user", "id": "u-other", "role": "READER", "organisationId": null, "verified": false, "parts": [], "sessionId": "s2"}

builder := {"kind": "user", "id": "u-builder", "role": "BUILDER", "organisationId": null, "verified": false, "parts": [], "sessionId": "s3"}

curator := {"kind": "user", "id": "u-curator", "role": "CURATOR", "organisationId": "org-a", "verified": true, "parts": ["P1"], "sessionId": "s4"}

admin_a := {"kind": "user", "id": "u-admin", "role": "ORG_ADMIN", "organisationId": "org-a", "verified": false, "parts": [], "sessionId": "s5"}

member_a := {"kind": "user", "id": "u-member", "role": "READER", "organisationId": "org-a", "verified": false, "parts": [], "sessionId": "s6"}

adjudicator := {"kind": "service", "id": "service:adjudicator", "role": null, "organisationId": null, "verified": false, "parts": [], "sessionId": null}

ctx := {"releaseId": "2026.09", "traceId": "t", "method": "GET", "path": "/", "now": "2026-09-22T00:00:00Z"}

inp(subject, action, resource) := {"subject": subject, "action": action, "resource": resource, "context": ctx}

# ── public ──────────────────────────────────────────────────────────────────

test_anonymous_reads_content if {
	authz.allow with input as inp(anon, "read", {"kind": "content", "id": "21.3"})
}

test_anonymous_reads_search if {
	authz.allow with input as inp(anon, "read", {"kind": "search", "id": null})
}

test_anonymous_may_login if {
	authz.allow with input as inp(anon, "login", {"kind": "auth", "id": null})
	authz.allow with input as inp(anon, "callback", {"kind": "auth", "id": null})
	authz.allow with input as inp(anon, "backchannel", {"kind": "auth", "id": null})
}

test_anonymous_reaches_an_object_by_its_signed_url if {
	authz.allow with input as inp(anon, "read", {"kind": "object", "id": "evidence/S-21-0001/4f1c/source"})
	authz.allow with input as inp(anon, "write", {"kind": "object", "id": "evidence/S-21-0001/4f1c/source"})
}

test_nobody_deletes_or_lists_objects_through_the_policy if {
	not authz.allow with input as inp(anon, "delete", {"kind": "object", "id": "evidence/S-21-0001/4f1c/source"})
	not authz.allow with input as inp(anon, "list", {"kind": "object", "id": null})
}

test_anonymous_cannot_write_content if {
	not authz.allow with input as inp(anon, "write", {"kind": "content", "id": "21.3"})
}

test_anonymous_cannot_touch_marks if {
	not authz.allow with input as inp(anon, "write", {"kind": "bookmark", "id": "21.3", "ownerId": null})
	not authz.allow with input as inp(anon, "list", {"kind": "bookmark", "id": null, "ownerId": null})
}

# ── reader state ────────────────────────────────────────────────────────────

test_reader_owns_marks if {
	authz.allow with input as inp(reader, "write", {"kind": "bookmark", "id": "21.3", "ownerId": "u-reader"})
	authz.allow with input as inp(reader, "delete", {"kind": "note", "id": "21.3", "ownerId": "u-reader"})
	authz.allow with input as inp(reader, "list", {"kind": "path-progress", "id": null, "ownerId": "u-reader"})
	authz.allow with input as inp(reader, "read", {"kind": "path-progress", "id": "builder", "ownerId": "u-reader"})
}

test_reader_cannot_touch_another_users_marks if {
	not authz.allow with input as inp(other, "delete", {"kind": "bookmark", "id": "21.3", "ownerId": "u-reader"})
	not authz.allow with input as inp(other, "write", {"kind": "note", "id": "21.3", "ownerId": "u-reader"})
	not authz.allow with input as inp(other, "list", {"kind": "bookmark", "id": null, "ownerId": "u-reader"})
}

test_marks_without_owner_are_denied if {
	not authz.allow with input as inp(reader, "write", {"kind": "bookmark", "id": "21.3"})
}

# ── sessions and self ───────────────────────────────────────────────────────

test_user_revokes_own_session_only if {
	authz.allow with input as inp(reader, "revoke", {"kind": "session", "id": "s1", "ownerId": "u-reader"})
	authz.allow with input as inp(reader, "list", {"kind": "session", "id": null, "ownerId": "u-reader"})
	not authz.allow with input as inp(other, "revoke", {"kind": "session", "id": "s1", "ownerId": "u-reader"})
}

test_user_reads_and_writes_self_only if {
	authz.allow with input as inp(reader, "read", {"kind": "user", "id": "u-reader"})
	authz.allow with input as inp(reader, "write", {"kind": "user", "id": "u-reader"})
	not authz.allow with input as inp(reader, "read", {"kind": "user", "id": "u-other"})
	not authz.allow with input as inp(reader, "manage", {"kind": "user", "id": "u-other"})
}

# ── organisations and roles ─────────────────────────────────────────────────

test_org_admin_manages_own_org_only if {
	authz.allow with input as inp(admin_a, "manage", {"kind": "org", "id": "org-a", "organisationId": "org-a"})
	authz.allow with input as inp(admin_a, "export", {"kind": "org", "id": "org-a", "organisationId": "org-a"})
	authz.allow with input as inp(admin_a, "manage", {"kind": "user", "id": "u-member", "organisationId": "org-a"})
	not authz.allow with input as inp(admin_a, "manage", {"kind": "org", "id": "org-b", "organisationId": "org-b"})
	not authz.allow with input as inp(member_a, "manage", {"kind": "org", "id": "org-a", "organisationId": "org-a"})
	not authz.allow with input as inp(reader, "read", {"kind": "org", "id": "org-a", "organisationId": "org-a"})
}

test_role_ladder if {
	authz.has_role("READER") with input as {"subject": builder}
	authz.has_role("BUILDER") with input as {"subject": builder}
	not authz.has_role("CONTRIBUTOR") with input as {"subject": builder}
	authz.has_role("CONTRIBUTOR") with input as {"subject": curator}
	authz.has_role("READER") with input as {"subject": admin_a}
	not authz.has_role("BUILDER") with input as {"subject": admin_a}
	not authz.has_role("READER") with input as {"subject": anon}
}

test_lab_sessions_need_builder if {
	authz.allow with input as inp(builder, "start", {"kind": "lab-session", "id": "lab-21"})
	authz.allow with input as inp(curator, "run", {"kind": "lab-session", "id": "lab-21", "organisationId": "org-a"})
	not authz.allow with input as inp(reader, "start", {"kind": "lab-session", "id": "lab-21"})
	not authz.allow with input as inp(admin_a, "start", {"kind": "lab-session", "id": "lab-21", "organisationId": "org-a"})
}

# ── tenant ──────────────────────────────────────────────────────────────────

test_cross_tenant_denied if {
	not authz.allow with input as inp(member_a, "read", {"kind": "note", "id": "21.3", "ownerId": "u-member", "organisationId": "org-b"})
	not authz.allow with input as inp(reader, "read", {"kind": "note", "id": "21.3", "ownerId": "u-reader", "organisationId": "org-a"})
	not authz.allow with input as inp(member_a, "read", {"kind": "bookmark", "id": "21.3", "ownerId": "u-member", "organisationId": null})
}

test_same_tenant_allowed if {
	authz.allow with input as inp(member_a, "read", {"kind": "note", "id": "21.3", "ownerId": "u-member", "organisationId": "org-a"})
	authz.allow with input as inp(member_a, "read", {"kind": "content", "id": "21.3", "organisationId": "org-b"})
}

# ── agents ──────────────────────────────────────────────────────────────────

test_service_never_reads_users if {
	not authz.allow with input as inp(adjudicator, "read", {"kind": "user", "id": "u-reader"})
	not authz.allow with input as inp(adjudicator, "manage", {"kind": "user", "id": "u-reader", "organisationId": null})
}

# What the adjudicator and a curator may decide is improve_test.rego's since unit 46d, row by row of
# feature-specs/29 § 6.2. Two things stay here because they are about a service as such: it has no other verb on
# a curation, and a builder is no curator.
test_a_service_has_no_verb_on_a_curation_but_its_own if {
	not authz.allow with input as inp(adjudicator, "write", {"kind": "curation", "id": "S-15-0377", "changeClass": "CITED_FIGURE", "origin": "HUMAN", "parts": ["P1"]})
	not authz.allow with input as inp(adjudicator, "delete", {"kind": "curation", "id": "S-15-0377", "changeClass": "CITED_FIGURE", "origin": "HUMAN", "parts": ["P1"]})
}

test_a_builder_decides_nothing_and_the_curator_of_the_part_does if {
	authz.allow with input as inp(curator, "decide", {"kind": "curation", "id": "S-15-0377", "changeClass": "CURATOR_ALWAYS", "origin": "HUMAN", "parts": ["P1"], "ownerId": "u-reader"})
	not authz.allow with input as inp(builder, "decide", {"kind": "curation", "id": "S-15-0377", "changeClass": "CITED_FIGURE", "origin": "HUMAN", "parts": ["P1"]})
}

# ── the assistant (feature-specs/15 § 5; unit 29b) ──────────────────────────

test_reader_creates_a_conversation if {
	authz.allow with input as inp(reader, "create", {"kind": "conversation", "id": null, "ownerId": null, "organisationId": null})
}

test_anonymous_creates_nothing if {
	not authz.allow with input as inp(anon, "create", {"kind": "conversation", "id": null, "ownerId": null, "organisationId": null})
}

test_reader_reads_and_asks_in_their_own_conversation if {
	authz.allow with input as inp(reader, "read", {"kind": "conversation", "id": "c-1", "ownerId": "u-reader", "organisationId": null})
	authz.allow with input as inp(reader, "ask", {"kind": "conversation", "id": "c-1", "ownerId": "u-reader", "organisationId": null})
}

test_reader_never_reads_another_readers_conversation if {
	not authz.allow with input as inp(other, "read", {"kind": "conversation", "id": "c-1", "ownerId": "u-reader", "organisationId": null})
	not authz.allow with input as inp(other, "ask", {"kind": "conversation", "id": "c-1", "ownerId": "u-reader", "organisationId": null})
}

test_an_org_admin_does_not_read_a_members_conversation if {
	not authz.allow with input as inp(admin_a, "read", {"kind": "conversation", "id": "c-2", "ownerId": "u-member", "organisationId": "org-a"})
}

test_reader_flags_their_own_message_and_no_other if {
	authz.allow with input as inp(reader, "write", {"kind": "message", "id": "m-1", "ownerId": "u-reader", "organisationId": null})
	not authz.allow with input as inp(other, "write", {"kind": "message", "id": "m-1", "ownerId": "u-reader", "organisationId": null})
}

test_no_service_identity_reads_a_conversation_or_a_message if {
	not authz.allow with input as inp(adjudicator, "read", {"kind": "conversation", "id": "c-1", "ownerId": "u-reader", "organisationId": null})
	not authz.allow with input as inp(adjudicator, "read", {"kind": "message", "id": "m-1", "ownerId": "u-reader", "organisationId": null})
}

# ── deleting a conversation (feature-specs/45 § 3.2; unit 62g) ──────────────

test_reader_deletes_their_own_conversation if {
	authz.allow with input as inp(reader, "delete", {"kind": "conversation", "id": "c-1", "ownerId": "u-reader", "organisationId": null})
}

test_nobody_else_deletes_a_conversation if {
	not authz.allow with input as inp(other, "delete", {"kind": "conversation", "id": "c-1", "ownerId": "u-reader", "organisationId": null})
	not authz.allow with input as inp(anon, "delete", {"kind": "conversation", "id": "c-1", "ownerId": "u-reader", "organisationId": null})
	not authz.allow with input as inp(admin_a, "delete", {"kind": "conversation", "id": "c-2", "ownerId": "u-member", "organisationId": "org-a"})
	not authz.allow with input as inp(adjudicator, "delete", {"kind": "conversation", "id": "c-1", "ownerId": "u-reader", "organisationId": null})
}

test_a_reader_deletes_no_message_alone if {
	not authz.allow with input as inp(reader, "delete", {"kind": "message", "id": "m-1", "ownerId": "u-reader", "organisationId": null})
}
