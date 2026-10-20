# The assistant's conversations and messages (feature-specs/15 § 5). A reader owns their own conversation and
# may create one, read it, ask in it, and since unit 62g delete it; they may flag a message of theirs. Nobody reads anyone else's, and no
# service identity reads either — a conversation is a reader's own words, and invariant 13 keeps agents out of
# anything that identifies one (architecture § 5.2, § 11.13).
package hb.authz

# A reader creates a conversation of their own. There is no id yet, so ownership is the subject itself.
permitted if {
	input.resource.kind == "conversation"
	input.action == "create"
	input.subject.kind == "user"
}

# Reading or asking in a conversation: the row's owner, and nobody else.
permitted if {
	input.resource.kind == "conversation"
	input.action in {"read", "ask", "list"}
	input.subject.kind == "user"
	input.resource.ownerId == input.subject.id
}

# Deleting a conversation (feature-specs/45 § 3.2; unit 62g): its owner, and nobody else. No organisation's
# administrator deletes a reader's conversation, as none reads one.
permitted if {
	input.resource.kind == "conversation"
	input.action == "delete"
	input.subject.kind == "user"
	input.resource.ownerId == input.subject.id
}

# Flagging a message of one's own conversation. A flag is a calibration label, so it is the reader's to give.
permitted if {
	input.resource.kind == "message"
	input.action in {"read", "write"}
	input.subject.kind == "user"
	input.resource.ownerId == input.subject.id
}

# No service identity touches either kind, whatever else it is allowed (invariant 13).
agent_denied if {
	is_service
	input.resource.kind in {"conversation", "message"}
}
