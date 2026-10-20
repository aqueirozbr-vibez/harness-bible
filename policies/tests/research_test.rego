# A person's research (feature-specs/48 § 14; unit 71a): its owner's every action, and the deny cases — another person,
# anonymous, a service, an organisation's admin on a member's research. Since unit 74 a finding's send to Improve: its
# owner's unless they draft, and the deny cases — a verified contributor, a verified curator, another person, a service.
# `npm run policy:test`.
package hb.authz_test

import data.hb.authz

research_asker := {"kind": "user", "id": "u-asker", "role": "READER", "organisationId": null, "verified": false, "parts": [], "sessionId": "s"}

research_other := {"kind": "user", "id": "u-other", "role": "CONTRIBUTOR", "organisationId": null, "verified": true, "parts": [], "sessionId": "s"}

research_member := {"kind": "user", "id": "u-member", "role": "READER", "organisationId": "org-a", "verified": false, "parts": [], "sessionId": "s"}

research_admin := {"kind": "user", "id": "u-admin", "role": "ORG_ADMIN", "organisationId": "org-a", "verified": true, "parts": [], "sessionId": "s"}

research_curator := {"kind": "user", "id": "u-curator", "role": "CURATOR", "organisationId": null, "verified": true, "parts": ["P1"], "sessionId": "s"}

research_nobody := {"kind": "anonymous", "id": null, "role": null, "organisationId": null, "verified": false, "parts": [], "sessionId": null}

research_researcher := {"kind": "service", "id": "service:researcher", "role": null, "organisationId": null, "verified": false, "parts": [], "sessionId": null}

research_owned_by(subject) := {"kind": "research", "id": "r-1", "ownerId": subject.id, "organisationId": subject.organisationId}

research_new(subject) := {"kind": "research", "id": null, "ownerId": subject.id, "organisationId": subject.organisationId}

research_actions := {"read", "list", "ask", "write", "export", "delete"}

test_a_person_opens_a_research_of_their_own if {
	authz.allow with input as inp(research_asker, "create", research_new(research_asker))
	authz.allow with input as inp(research_member, "create", research_new(research_member))
}

test_its_owner_does_everything_a_research_takes if {
	every action in research_actions {
		authz.allow with input as inp(research_asker, action, research_owned_by(research_asker))
		authz.allow with input as inp(research_member, action, research_owned_by(research_member))
	}
}

test_another_person_does_nothing_to_a_research if {
	every action in research_actions {
		not authz.allow with input as inp(research_other, action, research_owned_by(research_asker))
		not authz.allow with input as inp(research_curator, action, research_owned_by(research_asker))
	}
}

test_anonymous_opens_none_and_touches_none if {
	not authz.allow with input as inp(research_nobody, "create", research_new(research_nobody))
	every action in research_actions {
		not authz.allow with input as inp(research_nobody, action, research_owned_by(research_asker))
	}
}

test_no_service_reads_or_writes_a_research if {
	not authz.allow with input as inp(research_researcher, "create", {"kind": "research", "id": null, "ownerId": null, "organisationId": null})
	every action in research_actions {
		not authz.allow with input as inp(research_researcher, action, research_owned_by(research_asker))
		not authz.allow with input as inp(adjudicator, action, research_owned_by(research_asker))
	}
}

test_an_organisations_admin_does_nothing_to_a_members_research if {
	every action in research_actions {
		not authz.allow with input as inp(research_admin, action, research_owned_by(research_member))
	}
}

test_a_research_of_another_organisation_is_refused_by_the_tenant_rule if {
	# its owner's id, but a resource another organisation's: the tenant rule refuses before ownership matters
	not authz.allow with input as inp(research_member, "read", {"kind": "research", "id": "r-1", "ownerId": "u-member", "organisationId": "org-b"})
}

test_a_research_without_its_owner_is_refused if {
	not authz.allow with input as inp(research_asker, "read", {"kind": "research", "id": "r-1", "organisationId": null})
}

# ── a finding sent to Improve (feature-specs/48 § 8.3, § 14; unit 74) ─────────────────────────────────────────────────

finding_contributor := {"kind": "user", "id": "u-contributor", "role": "CONTRIBUTOR", "organisationId": null, "verified": true, "parts": [], "sessionId": "s"}

finding_unverified := {"kind": "user", "id": "u-unverified", "role": "CONTRIBUTOR", "organisationId": null, "verified": false, "parts": [], "sessionId": "s"}

finding_builder := {"kind": "user", "id": "u-builder", "role": "BUILDER", "organisationId": null, "verified": true, "parts": [], "sessionId": "s"}

finding_of(subject) := {"kind": "finding", "id": "f-1", "ownerId": subject.id, "organisationId": subject.organisationId}

test_anyone_who_does_not_draft_sends_their_own_finding if {
	authz.allow with input as inp(research_asker, "submit", finding_of(research_asker))
	authz.allow with input as inp(research_member, "submit", finding_of(research_member))
	authz.allow with input as inp(finding_unverified, "submit", finding_of(finding_unverified))
	authz.allow with input as inp(finding_builder, "submit", finding_of(finding_builder))
	authz.allow with input as inp(research_admin, "submit", finding_of(research_admin))
}

test_a_verified_contributor_drafts_and_is_refused_the_send if {
	not authz.allow with input as inp(finding_contributor, "submit", finding_of(finding_contributor))
	# the draft door's own rule lets them start a suggestion instead
	authz.allow with input as inp(finding_contributor, "create", {"kind": "suggestion", "id": null, "ownerId": finding_contributor.id, "origin": "HUMAN"})
}

test_a_verified_curator_drafts_and_is_refused_the_send if {
	not authz.allow with input as inp(research_curator, "submit", finding_of(research_curator))
}

test_another_persons_finding_is_refused if {
	not authz.allow with input as inp(research_other, "submit", finding_of(research_asker))
	not authz.allow with input as inp(research_asker, "submit", finding_of(research_member))
	not authz.allow with input as inp(research_admin, "submit", finding_of(research_member))
}

test_no_service_and_nobody_signed_out_sends_a_finding if {
	not authz.allow with input as inp(research_researcher, "submit", {"kind": "finding", "id": "f-1", "ownerId": null, "organisationId": null})
	not authz.allow with input as inp(research_researcher, "submit", finding_of(research_asker))
	not authz.allow with input as inp(adjudicator, "submit", finding_of(research_asker))
	not authz.allow with input as inp(research_nobody, "submit", finding_of(research_asker))
}

test_a_finding_takes_no_other_action if {
	every action in {"read", "write", "create", "delete", "draft"} {
		not authz.allow with input as inp(research_asker, action, finding_of(research_asker))
	}
}

test_a_finding_without_its_owner_is_refused if {
	not authz.allow with input as inp(research_asker, "submit", {"kind": "finding", "id": "f-1", "organisationId": null})
}
