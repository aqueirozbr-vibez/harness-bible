# The role ladder (architecture § 5.2; feature-specs/09 § 5.2 roles.rego):
# builder ⊇ reader, contributor ⊇ builder, curator ⊇ contributor, org_admin ⊇ reader.
package hb.authz

roles_of := {
	"READER": {"READER"},
	"BUILDER": {"READER", "BUILDER"},
	"CONTRIBUTOR": {"READER", "BUILDER", "CONTRIBUTOR"},
	"CURATOR": {"READER", "BUILDER", "CONTRIBUTOR", "CURATOR"},
	"ORG_ADMIN": {"READER", "ORG_ADMIN"},
}

has_role(role) if {
	input.subject.kind == "user"
	role in roles_of[input.subject.role]
}

# Lab sessions and runs need the builder role (Phase 3; the ladder is exercised now).
permitted if {
	input.resource.kind == "lab-session"
	input.action in {"start", "run"}
	has_role("BUILDER")
}

permitted if {
	input.resource.kind == "lab-session"
	input.action in {"read", "delete"}
	owner
}
