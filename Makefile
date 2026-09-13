.PHONY: help unit-test e2e-test

help: ## Show this help
	@grep -E '^[a-zA-Z0-9_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  %-15s %s\n", $$1, $$2}'

unit-test: ## Run unit tests for gateway and CLI with coverage
	@echo "=== Gateway unit tests ==="
	@cd gateway && go test -cover ./... 2>&1 | tee /tmp/gateway-unit.log
	@echo ""
	@echo "=== CLI unit tests ==="
	@cd cli && npx vitest run --coverage 2>&1 | tee /tmp/cli-unit.log
	@echo ""
	@echo "=== Coverage Summary ==="
	@echo "Gateway:"
	@grep -E 'coverage:' /tmp/gateway-unit.log || true
	@echo "CLI:"
	@grep -E '(All files|Statements)' /tmp/cli-unit.log | head -2 || true

e2e-test: ## Run e2e tests with coverage collection
	./e2e/coverage.sh
