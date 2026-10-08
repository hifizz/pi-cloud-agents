#!/usr/bin/env bash
# Back up and restore only Cua desktop customization state. Bot work and browser data are never included.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NAME="${TARSBOT_SPACE_CONTAINER:-tarsbot-space}"
PROBE="${TARSBOT_PROBE_CONTAINER:-tarsbot-probe}"
BACKUP_DIR="${TARSBOT_DESKTOP_BACKUP_DIR:-$ROOT/data/desktop-backups}"
DEFAULT_ARCHIVE="$BACKUP_DIR/default.tar.gz"

usage() {
  cat <<EOF
Usage:
  scripts/space-desktop-state.sh init-default
  scripts/space-desktop-state.sh backup [name]
  scripts/space-desktop-state.sh restore <name|archive.tar.gz>
  scripts/space-desktop-state.sh restore-default
  scripts/space-desktop-state.sh list

Backups only cover desktop settings, themes, icons, Plank and terminal appearance.
/home/cua/work and browser profiles are not touched.
EOF
}

exists() { docker inspect "$1" >/dev/null 2>&1; }
running() { [ "$(docker inspect -f '{{.State.Running}}' "$1" 2>/dev/null || true)" = "true" ]; }

archive_command='
  cd /home/cua
  shopt -s nullglob
  candidates=(
    .config/xfce4/xfconf/xfce-perchannel-xml/xfce4-panel.xml
    .config/xfce4/xfconf/xfce-perchannel-xml/xsettings.xml
    .config/xfce4/xfconf/xfce-perchannel-xml/xfwm4.xml
    .config/xfce4/xfconf/xfce-perchannel-xml/xfce4-desktop.xml
    .config/xfce4/panel
    .config/xfce4/terminal/terminalrc
    .config/dconf/user
    .config/plank
    .config/autostart/plank.desktop
    .themes/WhiteSur*
    .icons/WhiteSur*
    .local/share/icons/WhiteSur-cursors
    .local/share/plank
    .local/share/backgrounds/tarsbot-dark.png
    .local/share/backgrounds/tarsbot-dark.svg
    .local/bin/gnome-theme-switcher
    .local/share/applications/org.gnome.GTK4ThemeSwitcher.desktop
    .local/share/applications/tarsbot-finder.desktop
    .local/share/applications/tarsbot-terminal.desktop
  )
  paths=()
  for path in "${candidates[@]}"; do
    if [ -e "$path" ] || [ -L "$path" ]; then
      paths+=("$path")
    fi
  done
  tar --numeric-owner -czf - -- "${paths[@]}"
'

clean_command='
  rm -rf \
    /home/cua/.config/xfce4/xfconf/xfce-perchannel-xml/xfce4-panel.xml \
    /home/cua/.config/xfce4/xfconf/xfce-perchannel-xml/xsettings.xml \
    /home/cua/.config/xfce4/xfconf/xfce-perchannel-xml/xfwm4.xml \
    /home/cua/.config/xfce4/xfconf/xfce-perchannel-xml/xfce4-desktop.xml \
    /home/cua/.config/xfce4/panel \
    /home/cua/.config/xfce4/terminal/terminalrc \
    /home/cua/.config/dconf/user \
    /home/cua/.config/plank \
    /home/cua/.config/autostart/plank.desktop \
    /home/cua/.themes/WhiteSur* \
    /home/cua/.icons/WhiteSur* \
    /home/cua/.local/share/icons/WhiteSur-cursors \
    /home/cua/.local/share/plank \
    /home/cua/.local/share/backgrounds/tarsbot-dark.png \
    /home/cua/.local/share/backgrounds/tarsbot-dark.svg \
    /home/cua/.local/bin/gnome-theme-switcher \
    /home/cua/.local/share/applications/org.gnome.GTK4ThemeSwitcher.desktop \
    /home/cua/.local/share/applications/tarsbot-finder.desktop \
    /home/cua/.local/share/applications/tarsbot-terminal.desktop
'

mkdir -p "$BACKUP_DIR"

init_default() {
  exists "$PROBE" || { echo "desktop-state: pristine container $PROBE does not exist" >&2; exit 1; }
  local tmp="$DEFAULT_ARCHIVE.tmp"
  docker exec -u root "$PROBE" bash -c "$archive_command" >"$tmp"
  tar -tzf "$tmp" >/dev/null
  mv "$tmp" "$DEFAULT_ARCHIVE"
  {
    echo "source=$PROBE"
    echo "image=$(docker inspect -f '{{.Config.Image}}' "$PROBE")"
    echo "created_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  } >"$BACKUP_DIR/default.meta"
  echo "desktop-state: captured pristine default -> $DEFAULT_ARCHIVE"
}

backup() {
  exists "$NAME" || { echo "desktop-state: container $NAME does not exist" >&2; exit 1; }
  local label="${1:-$(date -u +%Y%m%dT%H%M%SZ)}"
  [[ "$label" =~ ^[A-Za-z0-9._-]+$ ]] || { echo "desktop-state: invalid backup name: $label" >&2; exit 1; }
  [ "$label" != "default" ] || { echo "desktop-state: backup name 'default' is reserved" >&2; exit 1; }
  local archive tmp
  archive="$BACKUP_DIR/$label.tar.gz"
  tmp="$archive.tmp"
  local image was_running=false
  image="$(docker inspect -f '{{.Config.Image}}' "$NAME")"
  if running "$NAME"; then
    was_running=true
    docker stop "$NAME" >/dev/null
  fi
  if ! docker run --rm --volumes-from "$NAME" --entrypoint bash "$image" -c "$archive_command" >"$tmp"; then
    rm -f "$tmp"
    $was_running && docker start "$NAME" >/dev/null
    return 1
  fi
  tar -tzf "$tmp" >/dev/null
  mv "$tmp" "$archive"
  {
    echo "source=$NAME"
    echo "image=$image"
    echo "created_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "scope=desktop-only"
  } >"$BACKUP_DIR/$label.meta"
  $was_running && docker start "$NAME" >/dev/null
  echo "desktop-state: backup -> $archive"
}

resolve_archive() {
  if [ -f "$1" ]; then
    printf '%s\n' "$1"
  elif [ -f "$BACKUP_DIR/$1.tar.gz" ]; then
    printf '%s\n' "$BACKUP_DIR/$1.tar.gz"
  else
    echo "desktop-state: backup not found: $1" >&2
    exit 1
  fi
}

validate_archive() {
  tar -tzf "$1" | awk '
    /^\// || /(^|\/)\.\.(\/|$)/ { bad=1 }
    END { exit bad }
  ' || { echo "desktop-state: unsafe archive paths in $1" >&2; exit 1; }
}

restore() {
  local archive="$1" recreate="${2:-false}"
  exists "$NAME" || { echo "desktop-state: container $NAME does not exist" >&2; exit 1; }
  validate_archive "$archive"

  # Always preserve the state being replaced.
  backup "pre-restore-$(date -u +%Y%m%dT%H%M%SZ)"

  local image volume port was_running=false
  image="$(docker inspect -f '{{.Config.Image}}' "$NAME")"
  volume="$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/home/cua"}}{{.Name}}{{end}}{{end}}' "$NAME")"
  port="$(docker port "$NAME" 3211/tcp | sed -n '1s/.*://p')"
  [ -n "$volume" ] || { echo "desktop-state: $NAME has no /home/cua named volume" >&2; exit 1; }
  [ -n "$port" ] || port=3211
  if running "$NAME"; then
    was_running=true
    docker stop "$NAME" >/dev/null
  fi

  restore_failed=true
  resume_on_error() {
    if $restore_failed && exists "$NAME" && $was_running && ! running "$NAME"; then
      docker start "$NAME" >/dev/null || true
    fi
  }
  trap resume_on_error EXIT

  docker run --rm --volumes-from "$NAME" --entrypoint bash "$image" -c "$clean_command"
  docker run --rm -i --volumes-from "$NAME" --entrypoint tar "$image" \
    --numeric-owner -xzpf - -C /home/cua <"$archive"

  if $recreate; then
    docker rm "$NAME" >/dev/null
    TARSBOT_SPACE_CONTAINER="$NAME" \
    TARSBOT_SPACE_VOLUME="$volume" \
    TARSBOT_SPACE_PORT="$port" \
    TARSBOT_SPACE_IMAGE="$image" \
      "$ROOT/scripts/space-up.sh"
    $was_running || docker stop "$NAME" >/dev/null
  elif $was_running; then
    docker start "$NAME" >/dev/null
  fi

  restore_failed=false
  trap - EXIT
  echo "desktop-state: restored <- $archive"
}

case "${1:-}" in
  init-default)
    init_default
    ;;
  backup)
    backup "${2:-}"
    ;;
  restore)
    [ -n "${2:-}" ] || { usage; exit 2; }
    restore "$(resolve_archive "$2")"
    ;;
  restore-default)
    [ -f "$DEFAULT_ARCHIVE" ] || init_default
    restore "$DEFAULT_ARCHIVE" true
    ;;
  list)
    find "$BACKUP_DIR" -maxdepth 1 -type f -name '*.tar.gz' -print | sort
    ;;
  *)
    usage
    exit 2
    ;;
esac
