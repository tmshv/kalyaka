set shell := ["bash", "-euo", "pipefail", "-c"]

binary := "kalyaka"
# Tag names may hold shell metacharacters; keep only what a version needs,
# since the value is spliced into recipe command lines.
version := `v="$(git describe --tags --always --dirty 2>/dev/null)" || v=dev; printf '%s' "${v:-dev}" | tr -cd 'A-Za-z0-9._+-'`
ldflags := "-s -w -X main.buildVersion=" + version
platforms := "linux/amd64 linux/arm64 darwin/amd64 darwin/arm64"

# List recipes
default:
    @just --list

# Run the server locally
run *args:
    go run . {{ args }}

# Vet and test
test:
    go vet ./...
    go test -race -count=1 ./...

# Build the binary for this machine into bin/
build:
    CGO_ENABLED=0 go build -trimpath -ldflags '{{ ldflags }}' -o bin/{{ binary }} .

# Cross-compile release archives and checksums into dist/
dist: clean
    mkdir -p dist
    for p in {{ platforms }}; do \
        os="${p%/*}"; arch="${p#*/}"; \
        name="{{ binary }}_{{ version }}_${os}_${arch}"; \
        mkdir -p "dist/$name"; \
        CGO_ENABLED=0 GOOS="$os" GOARCH="$arch" go build -trimpath -ldflags '{{ ldflags }}' -o "dist/$name/{{ binary }}" .; \
        cp LICENSE README.md "dist/$name/"; \
        tar -C dist -czf "dist/$name.tar.gz" "$name"; \
        rm -rf "dist/$name"; \
    done
    cd dist && shasum -a 256 *.tar.gz > checksums.txt

# Remove build output
clean:
    rm -rf bin dist

# Bump the version like `npm version`, tag it and push: just release patch|minor|major|X.Y.Z
release bump="patch":
    #!/usr/bin/env bash
    set -euo pipefail
    if [[ -n "$(git status --porcelain)" ]]; then
        echo "error: working tree is not clean" >&2
        exit 1
    fi
    last="$(git describe --tags --abbrev=0 --match 'v[0-9]*' 2>/dev/null || echo v0.0.0)"
    IFS=. read -r major minor patch <<< "${last#v}"
    case "{{ bump }}" in
        major) next="$((major + 1)).0.0" ;;
        minor) next="$major.$((minor + 1)).0" ;;
        patch) next="$major.$minor.$((patch + 1))" ;;
        *)
            if [[ ! "{{ bump }}" =~ ^v?[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
                echo "usage: just release patch|minor|major|X.Y.Z" >&2
                exit 1
            fi
            next="{{ bump }}"; next="${next#v}" ;;
    esac
    tag="v$next"
    if git rev-parse -q --verify "refs/tags/$tag" > /dev/null; then
        echo "error: tag $tag already exists" >&2
        exit 1
    fi
    just test
    echo "$last -> $tag"
    git tag -a "$tag" -m "$tag"
    git push origin HEAD "$tag"
