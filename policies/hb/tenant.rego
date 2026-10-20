# Tenant isolation (architecture § 5.3, invariant 24; feature-specs/09 § 5.2 tenant.rego):
# a resource of another organisation is denied unless the kind is public; a subject
# without an organisation matches only resources without one.
#
# The platform's kinds (improve.rego) are not an organisation's either: a suggestion is a contribution to the
# one book, and a curator of another organisation must read it (feature-specs/29 § 2). They are left to their
# own rules, which name every reader.
package hb.authz

tenant_violation if {
	not input.resource.kind in public_kinds
	not input.resource.kind in platform_kinds
	input.resource.organisationId != input.subject.organisationId
}
