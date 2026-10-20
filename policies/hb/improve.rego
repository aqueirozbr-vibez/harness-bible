# Improve (feature-specs/29 § 6.2; architecture § 5.2, § 5.4; invariants 13, 25 and 32): who may write a
# suggestion, who may read one, who may decide one, and who may put their name to a research proposal.
#
# What the rules read beyond the common input:
#   input.subject.verified   the person's identity was verified by the provider they signed in with
#   input.subject.parts      the parts of the book a curator has by the roster, read for this request
#   input.resource.ownerId   the contributor; for a proposal, the reader whose research run produced it
#   input.resource.parts     the parts the suggestion reaches
#   input.resource.changeClass, input.resource.origin
#   input.resource.merged    the suggestion is merged: its record is anyone's to read (feature-specs/35 D2; unit 54d)
#
# A rule that reads a field the caller left out does not fire, so a caller that leaves one out is refused.
# Consent is not here: it is a fact about the person at the moment of submitting or endorsing, checked and set
# by the endpoint (feature-specs/31 § 6.2, 42 § 6).
package hb.authz

# Suggestions, the curation of them and research proposals are the platform's rows, not an organisation's
# (feature-specs/29 § 2): a curator of another organisation, or of none, reads and decides them. The tenant rule
# (tenant.rego) leaves these kinds to the rules below, which name every reader themselves.
platform_kinds := {"suggestion", "curation", "proposal"}

verified if {
	input.subject.kind == "user"
	input.subject.verified == true
}

# A curator whose roster holds one of the parts the suggestion reaches.
curator_of_its_part if {
	has_role("CURATOR")
	some part in input.subject.parts
	part in input.resource.parts
}

# ── suggestion ──────────────────────────────────────────────────────────────

# A contributor or above, verified, starts a suggestion.
permitted if {
	input.resource.kind == "suggestion"
	input.action == "create"
	has_role("CONTRIBUTOR")
	verified
}

# Its owner reads and writes it.
permitted if {
	input.resource.kind == "suggestion"
	input.action in {"read", "write"}
	owner
}

# A curator of one of its parts reads it, and only reads it.
permitted if {
	input.resource.kind == "suggestion"
	input.action == "read"
	curator_of_its_part
}

# A curator reads a researcher's closed proposal whatever its parts (feature-specs/43 D6): the research log is one, and
# its lines open their records. The endpoint says `closed` only of a researcher's suggestion that is.
permitted if {
	input.resource.kind == "suggestion"
	input.action == "read"
	has_role("CURATOR")
	input.resource.origin == "RESEARCHER"
	input.resource.closed == true
}

# Once merged, its record is anyone's to read, signed out included (feature-specs/35 D2): the chapter's history
# links to it. The endpoint says `merged` only of a suggestion that is, and only where it serves the record.
permitted if {
	input.resource.kind == "suggestion"
	input.action == "read"
	input.resource.merged == true
}

# Its owner, verified, submits it (invariant 25).
permitted if {
	input.resource.kind == "suggestion"
	input.action == "submit"
	owner
	verified
}

# The researcher submits its own proposals and nobody else's suggestion.
permitted if {
	input.resource.kind == "suggestion"
	input.action == "submit"
	is_service
	input.subject.id == "service:researcher"
	input.resource.origin == "RESEARCHER"
}

# ── curation ────────────────────────────────────────────────────────────────

# The queue is a curator's to read; what is in it for them is the parts' business (lib/db/improve.ts).
permitted if {
	input.resource.kind == "curation"
	input.action == "read"
	has_role("CURATOR")
}

# A curator of one of the suggestion's parts decides it: any class, either origin. Never their own
# (feature-specs/36 § 7: a curator is also a contributor by role).
permitted if {
	input.resource.kind == "curation"
	input.action == "decide"
	curator_of_its_part
	not own_suggestion
}

own_suggestion if {
	input.resource.ownerId == input.subject.id
}

# The adjudicator decides, except where a person must: a curator-always change (invariant 13), and a
# researcher's proposal, which is never merged on the adjudicator's word (invariant 32).
permitted if {
	input.resource.kind == "curation"
	input.action == "decide"
	is_service
	input.subject.id == "service:adjudicator"
	input.resource.changeClass != "CURATOR_ALWAYS"
	input.resource.origin != "RESEARCHER"
}

# On a researcher's proposal it may recommend, which a curator then decides. Not on a curator-always change.
permitted if {
	input.resource.kind == "curation"
	input.action == "recommend"
	is_service
	input.subject.id == "service:adjudicator"
	input.resource.changeClass != "CURATOR_ALWAYS"
}

# ── proposal ────────────────────────────────────────────────────────────────

# The reader whose research run produced a proposal puts their name to it, whatever their role (Andre, A5).
permitted if {
	input.resource.kind == "proposal"
	input.action == "endorse"
	owner
}

# And reads it: the panel under their answer, the record and the outcome pages (feature-specs/43 D7). The endpoint
# names them owner from their own finding that names the suggestion, and from nothing else.
permitted if {
	input.resource.kind == "proposal"
	input.action == "read"
	owner
}
