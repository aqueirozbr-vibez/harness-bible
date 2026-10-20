# A person's research (feature-specs/48 § 14; unit 71a): a research conversation and its runs are the asker's own rows.
# The endpoints build the resource with `ownResource`, so its owner is the caller by construction, and the tenant
# filter makes another person's row absent: their id is a 404, never a 403 (feature-specs/15 § 5.2's rule). A
# finding's `submit` is unit 74's (§ 8.3, § 14): a send to Improve as a researcher's proposal, by its owner, unless they
# draft it in Improve instead.
package hb.authz

# A person opens a research of their own. There is no id yet, so ownership is the subject itself.
permitted if {
	input.resource.kind == "research"
	input.action == "create"
	input.subject.kind == "user"
}

# Its owner reads it, starts a run in it, flags a run of it, exports it and deletes it; nobody else. No organisation's
# administrator reads or deletes a member's research, as none reads a member's conversation.
permitted if {
	input.resource.kind == "research"
	input.action in {"read", "list", "ask", "write", "export", "delete"}
	input.subject.kind == "user"
	input.resource.ownerId == input.subject.id
}

# Its owner sends a finding of theirs to Improve as a researcher's proposal (feature-specs/48 § 8.3), unless they draft
# (A4): a verified contributor or curator turns a finding into a draft of their own through the draft door, which asks
# `create` on `suggestion` (improve.rego), and is refused the send, which would put their finding on the platform's
# budget past their own throttle (§ 8.1, § 22). Everyone else sends: a reader, a builder, an organisation's admin, an
# unverified contributor.
permitted if {
	input.resource.kind == "finding"
	input.action == "submit"
	input.subject.kind == "user"
	input.resource.ownerId == input.subject.id
	not drafts_findings
}

# Who drafts a finding rather than sends it (A4): the draft door's own rule, a contributor or above on the ladder,
# verified.
drafts_findings if {
	has_role("CONTRIBUTOR")
	verified
}

# No service identity reads or writes a research or a finding, whatever else it is allowed (invariant 13): a question
# is a person's own words, and a finding is theirs to use.
agent_denied if {
	is_service
	input.resource.kind in {"research", "finding"}
}
