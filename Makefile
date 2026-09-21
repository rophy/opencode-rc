.PHONY: help unit-test e2e-test

help: ## Show this help
	@grep -E '^[a-zA-Z0-9_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  %-15s %s\n", $$1, $$2}'

unit-test: ## Run unit tests for all packages with coverage
	@echo "=== Gateway (Go) ==="
	@cd gateway && go test -cover ./...
	@echo ""
	@echo "=== Web (TypeScript) ==="
	@cd web && npx vitest run --coverage
	@echo ""
	@echo "=== CLI (TypeScript) ==="
	@cd cli && npx vitest run --coverage
	@echo ""
	@echo "=== UI (SolidJS) ==="
	@cd ui && npx vitest run --coverage

e2e-test: ## Run e2e tests (Kind + Skaffold)
	./e2e/run.sh
