# Organisation reads and management: org admins of that organisation only
# (feature-specs/09 § 5.2 org.rego; the screen is Phase 4).
package hb.authz

permitted if {
	input.resource.kind == "org"
	input.action in {"read", "manage", "export"}
	has_role("ORG_ADMIN")
	input.resource.organisationId != null
	input.resource.organisationId == input.subject.organisationId
}
