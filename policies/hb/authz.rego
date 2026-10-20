# Harness Bible authorisation (feature-specs/09 § 5.2). Default deny.
# input: { subject: { kind, id, role, organisationId, verified, parts, sessionId },
#          action, resource: { kind, id, ownerId?, organisationId?, parts?, changeClass?, origin? },
#          context: { releaseId, traceId, method, path, now } }
# `subject.parts` is a curator's by the roster and empty for everyone else; the three after `organisationId` on
# the resource are a suggestion's own (improve.rego; feature-specs/29 § 6).
package hb.authz

default allow := false

allow if {
	permitted
	not tenant_violation
	not agent_denied
}

# The resource belongs to the subject.
owner if {
	input.subject.kind == "user"
	input.resource.ownerId == input.subject.id
}
