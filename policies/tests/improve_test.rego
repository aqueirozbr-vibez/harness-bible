# Improve's rules, row by row of feature-specs/29 § 6.2: for each, who is allowed and every refusal the row
# implies (29 § 10.6). `npm run policy:test`.
package hb.authz_test

import data.hb.authz

person(id, role, verified, parts, org) := {"kind": "user", "id": id, "role": role, "organisationId": org, "verified": verified, "parts": parts, "sessionId": "s"}

service(id) := {"kind": "service", "id": id, "role": null, "organisationId": null, "verified": false, "parts": [], "sessionId": null}

contributor := person("u-contributor", "CONTRIBUTOR", true, [], null)

unverified_contributor := person("u-unverified", "CONTRIBUTOR", false, [], null)

another_contributor := person("u-another", "CONTRIBUTOR", true, [], null)

verified_reader := person("u-verified-reader", "READER", true, [], null)

verified_builder := person("u-verified-builder", "BUILDER", true, [], null)

verified_admin := person("u-verified-admin", "ORG_ADMIN", true, [], "org-a")

curator_p3 := person("u-curator-p3", "CURATOR", true, ["P3"], "org-a")

curator_p1 := person("u-curator-p1", "CURATOR", true, ["P1"], null)

curator_of_none := person("u-curator-none", "CURATOR", true, [], null)

# A person who is not a curator and yet carries a part: the code never builds one, and the rules do not trust it.
contributor_with_parts := person("u-with-parts", "CONTRIBUTOR", true, ["P3"], null)

adjudicator_service := service("service:adjudicator")

researcher_service := service("service:researcher")

grader_service := service("service:grader")

intake_service := service("service:intake")

merge_service := service("service:merge")

# S-15-0377 as the PRD's fourth example has it: a contributor's, a cited figure, shared between Parts I and III.
suggestion := {"kind": "suggestion", "id": "S-15-0377", "ownerId": "u-contributor", "parts": ["P1", "P3"], "changeClass": "CITED_FIGURE", "origin": "HUMAN"}

curation := object.union(suggestion, {"kind": "curation"})

merged_suggestion := object.union(suggestion, {"merged": true})

unmerged_suggestion := object.union(suggestion, {"merged": false})

curator_always := object.union(curation, {"changeClass": "CURATOR_ALWAYS"})

# A researcher's proposal has no owner as a suggestion; as a proposal, its owner is the reader who asked.
researched := {"kind": "curation", "id": "S-21-0044", "ownerId": null, "parts": ["P3"], "changeClass": "CITED_FIGURE", "origin": "RESEARCHER"}

researched_suggestion := object.union(researched, {"kind": "suggestion"})

proposal := {"kind": "proposal", "id": "S-21-0044", "ownerId": "u-reader"}

new_suggestion := {"kind": "suggestion", "id": null}

# ── create · suggestion ─────────────────────────────────────────────────────

test_a_verified_contributor_or_a_curator_starts_a_suggestion if {
	authz.allow with input as inp(contributor, "create", new_suggestion)
	authz.allow with input as inp(curator_p3, "create", new_suggestion)
}

test_an_unverified_contributor_starts_none if {
	not authz.allow with input as inp(unverified_contributor, "create", new_suggestion)
}

test_nobody_below_contributor_starts_one_however_verified if {
	not authz.allow with input as inp(verified_reader, "create", new_suggestion)
	not authz.allow with input as inp(verified_builder, "create", new_suggestion)
	not authz.allow with input as inp(verified_admin, "create", new_suggestion)
	not authz.allow with input as inp(anon, "create", new_suggestion)
}

test_no_service_starts_a_suggestion_by_the_policy if {
	not authz.allow with input as inp(researcher_service, "create", new_suggestion)
	not authz.allow with input as inp(adjudicator_service, "create", new_suggestion)
}

# ── read, write · suggestion ────────────────────────────────────────────────

test_its_owner_reads_and_writes_a_suggestion if {
	authz.allow with input as inp(contributor, "read", suggestion)
	authz.allow with input as inp(contributor, "write", suggestion)
}

test_another_contributor_neither_reads_nor_writes_it if {
	not authz.allow with input as inp(another_contributor, "read", suggestion)
	not authz.allow with input as inp(another_contributor, "write", suggestion)
	not authz.allow with input as inp(anon, "read", suggestion)
}

# Unit 54d (feature-specs/35 D2): a merged suggestion's record is anyone's to read, and only to read.
test_anyone_reads_a_merged_suggestion_and_nobody_else_writes_it if {
	authz.allow with input as inp(anon, "read", merged_suggestion)
	authz.allow with input as inp(reader, "read", merged_suggestion)
	authz.allow with input as inp(another_contributor, "read", merged_suggestion)
	not authz.allow with input as inp(another_contributor, "write", merged_suggestion)
	not authz.allow with input as inp(reader, "write", merged_suggestion)
	not authz.allow with input as inp(anon, "read", unmerged_suggestion)
	not authz.allow with input as inp(reader, "read", unmerged_suggestion)
}

test_a_curator_of_one_of_its_parts_reads_it if {
	authz.allow with input as inp(curator_p3, "read", suggestion)
	authz.allow with input as inp(curator_p1, "read", suggestion)
	authz.allow with input as inp(curator_p3, "read", researched_suggestion)
}

test_a_curator_reads_it_and_does_not_write_it if {
	not authz.allow with input as inp(curator_p3, "write", suggestion)
	not authz.allow with input as inp(curator_p3, "submit", suggestion)
}

# Unit 63f (feature-specs/45 § 5.1): a researcher's proposal has no owner, so nobody writes it — nor withdraws it, a write.
test_nobody_writes_a_researchers_proposal if {
	not authz.allow with input as inp(contributor, "write", researched_suggestion)
	not authz.allow with input as inp(curator_p3, "write", researched_suggestion)
	not authz.allow with input as inp(anon, "write", researched_suggestion)
}

test_a_curator_outside_its_parts_does_not_read_it if {
	not authz.allow with input as inp(curator_p1, "read", researched_suggestion)
	not authz.allow with input as inp(curator_of_none, "read", suggestion)
}

test_parts_without_the_role_read_nothing if {
	not authz.allow with input as inp(contributor_with_parts, "read", suggestion)
}

test_a_suggestion_with_no_parts_given_is_no_curators_to_read if {
	not authz.allow with input as inp(curator_p3, "read", {"kind": "suggestion", "id": "S-15-0377", "ownerId": "u-contributor"})
}

test_no_service_reads_a_suggestion_by_the_policy if {
	not authz.allow with input as inp(grader_service, "read", suggestion)
	not authz.allow with input as inp(adjudicator_service, "write", suggestion)
}

# ── submit · suggestion ─────────────────────────────────────────────────────

test_its_verified_owner_submits_a_suggestion if {
	authz.allow with input as inp(contributor, "submit", suggestion)
}

test_an_unverified_owner_does_not_submit if {
	not authz.allow with input as inp(unverified_contributor, "submit", object.union(suggestion, {"ownerId": "u-unverified"}))
}

test_nobody_submits_another_persons_suggestion if {
	not authz.allow with input as inp(another_contributor, "submit", suggestion)
	not authz.allow with input as inp(curator_p3, "submit", suggestion)
}

test_the_researcher_submits_its_own_proposal if {
	authz.allow with input as inp(researcher_service, "submit", researched_suggestion)
}

test_the_researcher_submits_nobody_elses if {
	not authz.allow with input as inp(researcher_service, "submit", suggestion)
	not authz.allow with input as inp(researcher_service, "submit", {"kind": "suggestion", "id": "S-21-0044", "ownerId": null, "parts": ["P3"]})
}

test_no_other_service_submits_and_no_person_is_the_researcher if {
	not authz.allow with input as inp(adjudicator_service, "submit", researched_suggestion)
	not authz.allow with input as inp(intake_service, "submit", researched_suggestion)
	not authz.allow with input as inp(person("service:researcher", "CONTRIBUTOR", true, [], null), "submit", researched_suggestion)
}

# ── read · curation ─────────────────────────────────────────────────────────

test_a_curator_reads_the_queue if {
	authz.allow with input as inp(curator_p3, "read", {"kind": "curation", "id": null})
	authz.allow with input as inp(curator_of_none, "read", {"kind": "curation", "id": null})
}

test_nobody_else_reads_the_queue if {
	not authz.allow with input as inp(contributor, "read", {"kind": "curation", "id": null})
	not authz.allow with input as inp(verified_admin, "read", {"kind": "curation", "id": null})
	not authz.allow with input as inp(anon, "read", {"kind": "curation", "id": null})
	not authz.allow with input as inp(adjudicator_service, "read", {"kind": "curation", "id": null})
}

# ── decide · curation ───────────────────────────────────────────────────────

test_a_curator_of_one_of_its_parts_decides_any_class_and_either_origin if {
	authz.allow with input as inp(curator_p3, "decide", curation)
	authz.allow with input as inp(curator_p1, "decide", curation)
	authz.allow with input as inp(curator_p3, "decide", curator_always)
	authz.allow with input as inp(curator_p3, "decide", researched)
}

test_a_curator_outside_the_part_does_not_decide if {
	not authz.allow with input as inp(curator_p1, "decide", researched)
	not authz.allow with input as inp(curator_of_none, "decide", curation)
}

test_a_curator_does_not_decide_their_own_suggestion if {
	not authz.allow with input as inp(curator_p3, "decide", object.union(curation, {"ownerId": "u-curator-p3"}))
}

test_nobody_who_is_not_a_curator_decides if {
	not authz.allow with input as inp(contributor, "decide", curation)
	not authz.allow with input as inp(contributor_with_parts, "decide", curation)
	not authz.allow with input as inp(verified_admin, "decide", curation)
	not authz.allow with input as inp(anon, "decide", curation)
}

test_the_adjudicator_decides_a_persons_suggestion_of_an_automatic_class if {
	authz.allow with input as inp(adjudicator_service, "decide", curation)
}

test_the_adjudicator_never_decides_a_curator_always_change if {
	not authz.allow with input as inp(adjudicator_service, "decide", curator_always)
}

test_the_adjudicator_never_decides_a_researchers_proposal if {
	not authz.allow with input as inp(adjudicator_service, "decide", researched)
}

test_the_adjudicator_is_refused_when_the_class_or_the_origin_is_not_given if {
	not authz.allow with input as inp(adjudicator_service, "decide", {"kind": "curation", "id": "S-15-0377", "changeClass": "CITED_FIGURE"})
	not authz.allow with input as inp(adjudicator_service, "decide", {"kind": "curation", "id": "S-15-0377", "origin": "HUMAN"})
}

test_no_other_service_decides if {
	not authz.allow with input as inp(grader_service, "decide", curation)
	not authz.allow with input as inp(intake_service, "decide", curation)
	not authz.allow with input as inp(researcher_service, "decide", curation)
	not authz.allow with input as inp(merge_service, "decide", curation)
	not authz.allow with input as inp(person("service:adjudicator", "CONTRIBUTOR", true, [], null), "decide", curation)
}

# ── recommend · curation ────────────────────────────────────────────────────

test_the_adjudicator_recommends_on_a_researchers_proposal_and_on_a_persons if {
	authz.allow with input as inp(adjudicator_service, "recommend", researched)
	authz.allow with input as inp(adjudicator_service, "recommend", curation)
}

test_the_adjudicator_recommends_nothing_on_a_curator_always_change if {
	not authz.allow with input as inp(adjudicator_service, "recommend", curator_always)
	not authz.allow with input as inp(adjudicator_service, "recommend", object.union(researched, {"changeClass": "CURATOR_ALWAYS"}))
}

test_only_the_adjudicator_recommends if {
	not authz.allow with input as inp(curator_p3, "recommend", curation)
	not authz.allow with input as inp(researcher_service, "recommend", researched)
	not authz.allow with input as inp(contributor, "recommend", curation)
}

# ── endorse · proposal ──────────────────────────────────────────────────────

test_the_reader_who_asked_endorses_the_proposal_whatever_their_role if {
	authz.allow with input as inp(reader, "endorse", proposal)
	authz.allow with input as inp(curator_p3, "endorse", object.union(proposal, {"ownerId": "u-curator-p3"}))
}

test_no_other_reader_endorses_it if {
	not authz.allow with input as inp(other, "endorse", proposal)
	not authz.allow with input as inp(curator_p3, "endorse", proposal)
	not authz.allow with input as inp(anon, "endorse", proposal)
	not authz.allow with input as inp(researcher_service, "endorse", proposal)
}

test_a_proposal_with_no_owner_given_is_nobodys_to_endorse if {
	not authz.allow with input as inp(reader, "endorse", {"kind": "proposal", "id": "S-21-0044"})
}

# ── read · a closed researcher's proposal (43 D6) ──────────────────────────

test_a_curator_reads_a_closed_researchers_proposal_whatever_its_parts if {
	closed := {"kind": "suggestion", "id": "S-21-0044", "ownerId": null, "parts": ["P2"], "changeClass": "NEW_CLAIM", "origin": "RESEARCHER", "closed": true}
	authz.allow with input as inp(curator_p3, "read", closed)
	not authz.allow with input as inp(reader, "read", closed)
	not authz.allow with input as inp(contributor, "read", closed)
	not authz.allow with input as inp(curator_p3, "read", object.union(closed, {"origin": "HUMAN"}))
	not authz.allow with input as inp(curator_p3, "read", object.union(closed, {"closed": false}))
	not authz.allow with input as inp(curator_p3, "decide", closed)
}

# ── read · proposal (43 D7) ─────────────────────────────────────────────────

test_the_reader_who_asked_reads_the_proposal_and_nobody_else_as_its_asker if {
	authz.allow with input as inp(reader, "read", proposal)
	not authz.allow with input as inp(other, "read", proposal)
	not authz.allow with input as inp(curator_p3, "read", proposal)
	not authz.allow with input as inp(anon, "read", proposal)
	not authz.allow with input as inp(reader, "read", {"kind": "proposal", "id": "S-21-0044"})
	not authz.allow with input as inp(reader, "write", proposal)
}

# ── the platform's rows are not an organisation's ───────────────────────────

test_a_curator_of_another_organisation_reads_and_decides if {
	authz.allow with input as inp(curator_p3, "read", object.union(suggestion, {"organisationId": "org-b"}))
	authz.allow with input as inp(curator_p3, "read", object.union(suggestion, {"organisationId": null}))
	authz.allow with input as inp(curator_p3, "decide", object.union(curation, {"organisationId": "org-b"}))
}

test_being_of_no_tenant_gives_nothing_the_rules_do_not if {
	not authz.allow with input as inp(member_a, "read", object.union(suggestion, {"organisationId": "org-a"}))
	not authz.allow with input as inp(admin_a, "decide", object.union(curation, {"organisationId": "org-a"}))
}

# ── what no service may touch, for each of Improve's ────────────────────────

test_no_service_of_improve_reads_a_user_a_conversation_or_a_message if {
	every agent in [adjudicator_service, researcher_service, grader_service, intake_service, merge_service] {
		not authz.allow with input as inp(agent, "read", {"kind": "user", "id": "u-reader"})
		not authz.allow with input as inp(agent, "read", {"kind": "conversation", "id": "c-1", "ownerId": "u-reader", "organisationId": null})
		not authz.allow with input as inp(agent, "read", {"kind": "message", "id": "m-1", "ownerId": "u-reader", "organisationId": null})
	}
}
