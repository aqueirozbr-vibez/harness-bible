# A user reads, lists and revokes only sessions of their own (feature-specs/09 § 5.2 session.rego).
package hb.authz

permitted if {
	input.resource.kind == "session"
	input.action in {"read", "list", "revoke"}
	owner
}
