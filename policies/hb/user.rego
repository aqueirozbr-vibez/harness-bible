# A user reads and writes their own account; an org admin manages users of the same
# organisation (feature-specs/09 § 5.2 user.rego; manage is Phase 4).
package hb.authz

permitted if {
	input.resource.kind == "user"
	input.action in {"read", "write"}
	input.subject.kind == "user"
	input.resource.id == input.subject.id
}

permitted if {
	input.resource.kind == "user"
	input.action == "manage"
	has_role("ORG_ADMIN")
	input.resource.organisationId != null
	input.resource.organisationId == input.subject.organisationId
}
