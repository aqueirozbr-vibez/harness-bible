# Public reads and the authentication routes (feature-specs/09 § 5.2 public.rego).
package hb.authz

public_kinds := {"content", "search", "auth", "object"}

permitted if {
	input.resource.kind == "content"
	input.action == "read"
}

permitted if {
	input.resource.kind == "search"
	input.action == "read"
}

permitted if {
	input.resource.kind == "auth"
	input.action in {"login", "callback", "backchannel"}
}

# A stored object is reached by its signed URL alone (feature-specs/32 § 5, unit 49b): the storage routes verify
# the signature — one key, one method, ten minutes — before this is asked, and the URL is handed out only by an
# endpoint that asked this policy about the suggestion. So anyone with the URL may do the one thing it names.
permitted if {
	input.resource.kind == "object"
	input.action in {"read", "write"}
}
