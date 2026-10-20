# The audit pack (feature-specs/38 § 3; unit 55b): who may ask for one, and who reads the one they asked for.
#
# What the rules read beyond the common input:
#   input.resource.scope           "account" or "chapter", the pack's scope
#   input.resource.ownerId         the account the pack is of (an account scope), or the requester (a read)
#   input.resource.organisationId  the organisation the pack is of, or the requester's, for the tenant rule
#
# A rule that reads a field the caller left out does not fire, so a caller that leaves one out is refused.
package hb.authz

# Any signed-in person exports their own account's records (38 D1).
permitted if {
	input.resource.kind == "audit-export"
	input.action == "export"
	input.resource.scope == "account"
	input.subject.kind == "user"
	input.resource.ownerId != null
	input.resource.ownerId == input.subject.id
}

# An organisation's admin exports the organisation's.
permitted if {
	input.resource.kind == "audit-export"
	input.action == "export"
	input.resource.scope == "account"
	has_role("ORG_ADMIN")
	input.resource.ownerId == null
	input.resource.organisationId != null
	input.resource.organisationId == input.subject.organisationId
}

# Any signed-in person exports a chapter's, whose records are public once merged (35 D2).
permitted if {
	input.resource.kind == "audit-export"
	input.action == "export"
	input.resource.scope == "chapter"
	input.subject.kind == "user"
}

# A pack is read by the person who asked for it.
permitted if {
	input.resource.kind == "audit-export"
	input.action == "read"
	input.subject.kind == "user"
	input.resource.ownerId != null
	input.resource.ownerId == input.subject.id
}
