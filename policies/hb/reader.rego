# Reader state: bookmarks, notes and path progress belong to the user who made them
# (feature-specs/09 § 5.2 reader.rego). Any role may keep marks.
package hb.authz

reader_kinds := {"bookmark", "note", "path-progress"}

permitted if {
	input.resource.kind in reader_kinds
	input.action in {"read", "write", "delete", "list"}
	owner
}
