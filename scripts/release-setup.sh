#!/usr/bin/env bash
# Prepares npm so that .github/workflows/release.yml publishes on its own when a
# pull request that bumps the version is merged to main:
#
#   1. logs in to npm (the trust commands need a login with 2FA, not a token);
#   2. publishes by hand, without provenance, the packages that do not exist on
#      npm yet, since npm cannot publish a new package through OIDC;
#   3. registers the Release workflow as the trusted publisher of every package;
#   4. runs the Release workflow on main, which publishes what is missing with
#      provenance and creates the tag and the GitHub release.
#
# Each step skips what is already done, so the script can be run again, for
# instance after adding a new package under packages/.
#
#   bash scripts/release-setup.sh
set -euo pipefail
cd "$(dirname "$0")/.."

REPO=afora-framework/core
WORKFLOW=release.yml
ENVIRONMENT=npm
# core first, then the packages that depend on it (mcp depends on codegen)
DIRS=(. packages/codegen packages/mcp packages/hono packages/ws packages/drizzle packages/dynamodb)

# npm trust needs npm >= 11.10; the npm of the local Node may be older
npm_() { npx -y npm@11 "$@"; }
name_of() { node -p "require('./$1/package.json').name"; }
confirm() {
	local answer
	read -r -p "$1 [y/N] " answer
	[[ "$answer" == [yY]* ]]
}

VERSION="$(node -p 'require("./package.json").version')"
case "$VERSION" in
*-*) DIST_TAG=next ;;
*) DIST_TAG=latest ;;
esac

echo "==> npm login"
if ! npm_ whoami >/dev/null 2>&1; then
	npm_ login
fi
echo "logged in as $(npm_ whoami)"

echo "==> first publish of the packages that are not on npm"
missing=()
for dir in "${DIRS[@]}"; do
	name="$(name_of "$dir")"
	if npm_ view "$name" name >/dev/null 2>&1; then
		echo "$name exists"
	else
		echo "$name is not on npm yet"
		missing+=("$dir")
	fi
done

if ((${#missing[@]})); then
	git fetch -q origin main
	if [[ "$(git rev-parse HEAD)" != "$(git rev-parse origin/main)" || -n "$(git status --porcelain --untracked-files=no)" ]]; then
		echo "warning: the working tree is not a clean origin/main; these packages will be published from it"
		confirm "Publish anyway?" || exit 1
	fi

	bun install --frozen-lockfile
	bun run build:packages

	# npm does not rewrite the workspace: protocol, so pin the real version and
	# put the manifest back afterwards
	mcp_backup="$(mktemp)"
	cp packages/mcp/package.json "$mcp_backup"
	trap 'cp "$mcp_backup" packages/mcp/package.json; rm -f "$mcp_backup"' EXIT
	(cd packages/mcp && npm_ pkg set "dependencies.@afora/codegen=^$VERSION")

	for dir in "${missing[@]}"; do
		echo "publishing $(name_of "$dir")@$VERSION"
		# provenance only works inside CI
		(cd "$dir" && npm_ publish --provenance=false --tag "$DIST_TAG")
	done
fi

echo "==> trusted publisher: $REPO, $WORKFLOW, environment $ENVIRONMENT"
# The trust commands ask for 2FA (a code or the browser), so they run attached to
# the terminal; --json would turn that prompt into an EOTP error.
trust() {
	npm_ trust github "$1" \
		--file "$WORKFLOW" \
		--repo "$REPO" \
		--env "$ENVIRONMENT" \
		--allow-publish \
		--yes
}
for dir in "${DIRS[@]}"; do
	name="$(name_of "$dir")"
	echo "--- $name"
	trust "$name" && continue

	# npm keeps a single configuration per package: the usual cause of a failure
	# here (E409) is one that already exists, often the very same one
	echo "could not register $name; its current trusted publisher:"
	current="$(npm_ trust list "$name" | tee /dev/stderr || true)"
	if grep -qx "file: $WORKFLOW" <<<"$current" &&
		grep -qx "repository: $REPO" <<<"$current" &&
		grep -qx "environment: $ENVIRONMENT" <<<"$current" &&
		grep -qE '^permissions: (.*, )?publish(,|$)' <<<"$current"; then
		echo "$name is already configured"
		continue
	fi
	if confirm "If it is not $REPO / $WORKFLOW / $ENVIRONMENT with publish allowed, revoke it and register again?"; then
		read -r -p "id to revoke: " id
		npm_ trust revoke "$name" --id="$id"
		trust "$name"
	fi
done

echo "==> Release workflow"
if git ls-remote --exit-code --tags origin "refs/tags/v$VERSION" >/dev/null; then
	echo "v$VERSION is already released; the next version bump merged to main publishes on its own"
	exit 0
fi

started="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
gh workflow run "$WORKFLOW" --repo "$REPO" --ref main
run_id=""
for _ in $(seq 1 20); do
	run_id="$(gh run list --repo "$REPO" --workflow "$WORKFLOW" --event workflow_dispatch --limit 1 \
		--json databaseId,createdAt --jq ".[] | select(.createdAt >= \"$started\") | .databaseId")"
	[[ -n "$run_id" ]] && break
	sleep 3
done
if [[ -z "$run_id" ]]; then
	echo "the run did not show up; follow it with: gh run list --workflow $WORKFLOW"
	exit 1
fi
gh run watch "$run_id" --repo "$REPO" --exit-status
echo "v$VERSION released: https://github.com/$REPO/releases/tag/v$VERSION"
