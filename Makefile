.PHONY: help unit-test e2e-test

help: ## Show this help
	@grep -E '^[a-zA-Z0-9_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  %-15s %s\n", $$1, $$2}'

unit-test: ## Run unit tests for backend and CLI with coverage
	@echo "=== Backend unit tests ==="
	@cd backend && go test -cover ./... 2>&1 | tee /tmp/backend-unit.log
	@echo ""
	@echo "=== CLI unit tests ==="
	@cd cli && npx vitest run --coverage 2>&1 | tee /tmp/cli-unit.log
	@echo ""
	@echo "=== Coverage Summary ==="
	@echo "Backend:"
	@grep -E 'coverage:' /tmp/backend-unit.log || true
	@echo "CLI:"
	@grep -E '(All files|Statements)' /tmp/cli-unit.log | head -2 || true

e2e-test: ## Run e2e tests with coverage collection
	./e2e/coverage.sh
