# Service identities (architecture § 5.2 "agent (dual identity)", invariant 13;
# feature-specs/09 § 5.2 agent.rego). What a service may do is in the file of the thing it does it to: the
# adjudicator's and the researcher's rules are improve.rego's since unit 46d (feature-specs/29 § 6.2). What no
# service may ever do is here.
package hb.authz

is_service if {
	input.subject.kind == "service"
}

# No service ever reads a user.
agent_denied if {
	is_service
	input.resource.kind == "user"
}
