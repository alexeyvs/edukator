#!/usr/bin/env bash

set -Eeuo pipefail

mode="${1:-install}"
os_release="${EDUKATOR_OCR_OS_RELEASE:-/etc/os-release}"

die() {
  printf 'ocr-setup: %s\n' "$*" >&2
  exit 1
}

version_at_least() {
  local actual="$1" minimum="$2"
  [[ "$(printf '%s\n%s\n' "$minimum" "$actual" | sort -V | head -n 1)" == "$minimum" ]]
}

version_of() {
  local binary="$1" output version
  case "$binary" in
    ocrmypdf) output="$(ocrmypdf --version 2>&1)" ;;
    tesseract) output="$(tesseract --version 2>&1 | head -n 1)" ;;
    pdftoppm) output="$(pdftoppm -v 2>&1 | head -n 1)" ;;
    qpdf) output="$(qpdf --version 2>&1 | head -n 1)" ;;
    *) die "неизвестная OCR-зависимость $binary" ;;
  esac
  version="$(printf '%s' "$output" | grep -Eo '[0-9]+(\.[0-9]+){1,2}' | head -n 1)"
  [[ -n "$version" ]] || die "не удалось определить версию $binary"
  printf '%s' "$version"
}

check_host() {
  local missing=() binary actual languages
  [[ -r "$os_release" ]] || die 'не найден /etc/os-release'
  # shellcheck disable=SC1090
  source "$os_release"
  [[ "${ID:-}" == ubuntu ]] || die "поддерживается только Ubuntu 22.04+"
  version_at_least "${VERSION_ID:-0}" 22.04 || die 'требуется Ubuntu 22.04 или новее'

  for binary in ocrmypdf tesseract pdftotext pdftoppm qpdf; do
    if [[ " ${EDUKATOR_OCR_FORCE_MISSING:-} " == *" $binary "* ]]; then
      missing+=("$binary")
    else
      command -v "$binary" >/dev/null 2>&1 || missing+=("$binary")
    fi
  done
  ((${#missing[@]} == 0)) || die "не установлены: ${missing[*]}"

  for specification in 'ocrmypdf 13.0' 'tesseract 5.0' 'pdftoppm 22.0' 'qpdf 10.0'; do
    read -r binary minimum <<<"$specification"
    actual="$(version_of "$binary")"
    version_at_least "$actual" "$minimum" || die "$binary $actual устарел; требуется $minimum+"
  done

  languages="$(tesseract --list-langs 2>&1)"
  for language in rus eng; do
    grep -Fxq "$language" <<<"$languages" || die "Tesseract не содержит язык $language"
  done
}

case "$mode" in
  --check)
    check_host
    printf '%s\n' 'ocr-setup: зависимости готовы'
    ;;
  install)
    [[ "${EDUKATOR_OCR_REQUIRE_ROOT:-1}" == 0 || "$(id -u)" == 0 ]] \
      || die 'установку нужно запускать от root'
    [[ -r "$os_release" ]] || die 'не найден /etc/os-release'
    # shellcheck disable=SC1090
    source "$os_release"
    [[ "${ID:-}" == ubuntu ]] || die 'поддерживается только Ubuntu 22.04+'
    version_at_least "${VERSION_ID:-0}" 22.04 || die 'требуется Ubuntu 22.04 или новее'
    export DEBIAN_FRONTEND=noninteractive
    apt-get update
    apt-get install -y --no-install-recommends \
      ocrmypdf tesseract-ocr tesseract-ocr-rus tesseract-ocr-eng poppler-utils qpdf
    check_host
    ;;
  *)
    die 'использование: install-ocr-dependencies.sh [--check]'
    ;;
esac
