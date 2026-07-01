# syntax=docker/dockerfile:1.7

FROM fedora:43@sha256:762d73ba1c455232b0272c5d445a34f36c4b9f421cbc05ce8102552325b6a222

ARG TARGETARCH
ARG BUN_VERSION=1.3.0
ARG BUN_SHA256_AMD64=60c39d92b8bd090627524c98b3012f0c08dc89024cfdaa7c9c98cb5fd4359376
ARG BUN_SHA256_ARM64=68b7dcd86a35e7d5e156b37e4cef4b4ab6d6b37fd2179570c0e815f13890febd
ARG ZIG_VERSION=0.16.0
ARG ZIG_SHA256_AMD64=70e49664a74374b48b51e6f3fdfbf437f6395d42509050588bd49abe52ba3d00
ARG ZIG_SHA256_ARM64=ea4b09bfb22ec6f6c6ceac57ab63efb6b46e17ab08d21f69f3a48b38e1534f17

RUN set -eu; \
	fedora_release_repo="https://dl.fedoraproject.org/pub/fedora/linux/releases/43/Everything/$(rpm --eval '%{_arch}')/os/"; \
	dnf -y \
		--disablerepo='*' \
		--repofrompath=fedora-release,"${fedora_release_repo}" \
		--setopt=fedora-release.gpgcheck=1 \
		--setopt=fedora-release.gpgkey=file:///etc/pki/rpm-gpg/RPM-GPG-KEY-fedora-43-primary \
		--setopt=install_weak_deps=False \
		install \
		bash-5.3.0-2.fc43 \
		ca-certificates-2025.2.80_v9.0.304-1.2.fc43 \
		curl-8.15.0-7.fc43 \
		git-2.51.0-2.fc43 \
		kcov-43-3.fc43 \
		tar-1.35-6.fc43 \
		unzip-6.0-67.fc43 \
		xz-5.8.1-4.fc43 \
	&& dnf clean all \
	&& rm -rf /var/cache/dnf

RUN set -eu; \
	case "${TARGETARCH}" in \
		amd64) bun_arch="x64"; bun_sha="${BUN_SHA256_AMD64}"; zig_arch="x86_64"; zig_sha="${ZIG_SHA256_AMD64}" ;; \
		arm64) bun_arch="aarch64"; bun_sha="${BUN_SHA256_ARM64}"; zig_arch="aarch64"; zig_sha="${ZIG_SHA256_ARM64}" ;; \
		*) echo "unsupported TARGETARCH=${TARGETARCH}" >&2; exit 1 ;; \
	esac; \
	bun_url="https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-linux-${bun_arch}.zip"; \
	curl -fsSL "${bun_url}" -o /tmp/bun.zip; \
	echo "${bun_sha}  /tmp/bun.zip" | sha256sum -c -; \
	unzip -q /tmp/bun.zip -d /tmp; \
	install -m 0755 "/tmp/bun-linux-${bun_arch}/bun" /usr/local/bin/bun; \
	rm -rf /tmp/bun.zip "/tmp/bun-linux-${bun_arch}"; \
	zig_url="https://ziglang.org/download/${ZIG_VERSION}/zig-${zig_arch}-linux-${ZIG_VERSION}.tar.xz"; \
	curl -fsSL "${zig_url}" -o /tmp/zig.tar.xz; \
	echo "${zig_sha}  /tmp/zig.tar.xz" | sha256sum -c -; \
	mkdir -p /opt/zig; \
	tar -xJf /tmp/zig.tar.xz -C /opt/zig --strip-components=1; \
	ln -s /opt/zig/zig /usr/local/bin/zig; \
	rm /tmp/zig.tar.xz; \
	zig version; \
	kcov --version; \
	bun --version

WORKDIR /work

RUN useradd --uid 1000 --create-home --shell /usr/sbin/nologin zq
USER zq
