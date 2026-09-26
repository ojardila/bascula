# Repo-level shortcuts. The API's own targets live in services/api/Makefile.
#
#   make db-diagram   regenerate docs/database.md from the migrations (Docker)

.PHONY: db-diagram

db-diagram:
	./scripts/db-diagram.sh
