# The audit pack's rules (feature-specs/38 § 3, D1): who exports an account's, an organisation's, a chapter's, and who
# reads a pack. `npm run policy:test`.
package hb.authz_test

import data.hb.authz

audit_reader := {"kind": "user", "id": "u-reader", "role": "READER", "organisationId": null, "verified": false, "parts": [], "sessionId": "s"}

audit_member := {"kind": "user", "id": "u-member", "role": "CONTRIBUTOR", "organisationId": "org-a", "verified": true, "parts": [], "sessionId": "s"}

audit_admin_a := {"kind": "user", "id": "u-admin-a", "role": "ORG_ADMIN", "organisationId": "org-a", "verified": true, "parts": [], "sessionId": "s"}

audit_admin_b := {"kind": "user", "id": "u-admin-b", "role": "ORG_ADMIN", "organisationId": "org-b", "verified": true, "parts": [], "sessionId": "s"}

audit_nobody := {"kind": "anonymous", "id": null, "role": null, "organisationId": null, "verified": false, "parts": [], "sessionId": null}

own_account(subject) := {"kind": "audit-export", "id": subject.id, "scope": "account", "ownerId": subject.id, "organisationId": subject.organisationId}

organisation_a := {"kind": "audit-export", "id": "org-a", "scope": "account", "ownerId": null, "organisationId": "org-a"}

chapter_21(subject) := {"kind": "audit-export", "id": "21", "scope": "chapter", "ownerId": null, "organisationId": subject.organisationId}

pack_of(requester) := {"kind": "audit-export", "id": "e-1", "scope": "account", "ownerId": requester.id, "organisationId": requester.organisationId}

test_a_person_exports_their_own_account if {
	authz.allow with input as inp(audit_reader, "export", own_account(audit_reader))
	authz.allow with input as inp(audit_member, "export", own_account(audit_member))
	authz.allow with input as inp(audit_admin_a, "export", own_account(audit_admin_a))
}

test_nobody_exports_another_persons_account if {
	not authz.allow with input as inp(audit_member, "export", own_account(audit_reader))
	not authz.allow with input as inp(audit_admin_a, "export", own_account(audit_member))
	not authz.allow with input as inp(audit_nobody, "export", own_account(audit_reader))
}

test_an_organisations_admin_exports_the_organisation_and_nobody_else_does if {
	authz.allow with input as inp(audit_admin_a, "export", organisation_a)
	not authz.allow with input as inp(audit_admin_b, "export", organisation_a)
	not authz.allow with input as inp(audit_member, "export", organisation_a)
	not authz.allow with input as inp(audit_nobody, "export", organisation_a)
}

test_anyone_signed_in_exports_a_chapter if {
	authz.allow with input as inp(audit_reader, "export", chapter_21(audit_reader))
	authz.allow with input as inp(audit_member, "export", chapter_21(audit_member))
	not authz.allow with input as inp(audit_nobody, "export", chapter_21(audit_nobody))
}

test_a_pack_is_read_by_its_requester_alone if {
	authz.allow with input as inp(audit_member, "read", pack_of(audit_member))
	not authz.allow with input as inp(audit_admin_a, "read", pack_of(audit_member))
	not authz.allow with input as inp(audit_reader, "read", pack_of(audit_member))
	not authz.allow with input as inp(audit_nobody, "read", pack_of(audit_member))
}

test_a_resource_without_its_scope_is_refused if {
	not authz.allow with input as inp(audit_member, "export", {"kind": "audit-export", "id": "u-member", "ownerId": "u-member", "organisationId": "org-a"})
}
