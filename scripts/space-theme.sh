#!/usr/bin/env bash
# Idempotent: give the Cua Space desktop a macOS-like dark minimal look (WhiteSur theme/icons/cursors, Inter + Noto CJK
# fonts, dark wallpaper) and apply it live via xfconf. Themes/icons/cursors/wallpaper live in /home/cua (persistent
# volume); fonts are apt packages, so rerun this script after recreating the container.
# Usage: scripts/space-theme.sh [--apply-only]   (env: TARSBOT_SPACE_CONTAINER)
#   --apply-only  skip package/theme installation and only re-apply settings (panel, wallpaper, xfconf)
set -euo pipefail

NAME="${TARSBOT_SPACE_CONTAINER:-tarsbot-space}"
HOMEDIR=/home/cua
GTK_THEME=WhiteSur-Dark
ICON_THEME=WhiteSur-dark
CURSOR_THEME=WhiteSur-cursors
WALLPAPER="$HOMEDIR/.local/share/backgrounds/tarsbot-dark.png"

as_root() { docker exec -u root -e DEBIAN_FRONTEND=noninteractive "$NAME" bash -c "$1"; }
as_cua() {
  docker exec -u cua \
    -e HOME="$HOMEDIR" -e USER=cua -e TERM=xterm \
    -e GTK_THEME="$GTK_THEME" -e ICON_THEME="$ICON_THEME" \
    -e CURSOR_THEME="$CURSOR_THEME" -e WALLPAPER="$WALLPAPER" \
    "$NAME" bash -c "$1"
}

if [ "${1:-}" != "--apply-only" ]; then
echo "space-theme: fonts (Inter, Fira Code, Noto CJK, emoji) + desktop deps"
as_root 'dpkg --configure -a; apt-get update -qq && apt-get install -y -qq --no-install-recommends fonts-inter fonts-firacode fonts-noto-cjk fonts-noto-color-emoji sassc git ca-certificates libglib2.0-dev-bin libxml2-utils librsvg2-common librsvg2-bin plank xfce4-appmenu-plugin appmenu-gtk3-module >/dev/null && fc-cache -f'

echo "space-theme: WhiteSur theme / icons / cursors -> $HOMEDIR"
as_cua '
  set -e
  export PATH="$PATH:/usr/sbin:/sbin"
  W=$(mktemp -d); trap "rm -rf $W" EXIT; cd "$W"
  for r in gtk-theme icon-theme; do git clone -q --depth 1 "https://github.com/vinceliuice/WhiteSur-$r.git"; done
  git clone -q --depth 1 https://github.com/vinceliuice/WhiteSur-cursors.git
  mkdir -p ~/.themes ~/.icons ~/.local/share/icons
  (cd WhiteSur-gtk-theme && ./install.sh -d ~/.themes -c Dark -o normal >/dev/null)
  (cd WhiteSur-icon-theme && ./install.sh -d ~/.icons -b >/dev/null)
  (cd WhiteSur-cursors && ./install.sh >/dev/null)
'

echo "space-theme: wallpaper"
# xfdesktop could not load an SVG here, so render a PNG (dark radial gradient) with ImageMagick.
as_cua "mkdir -p $(dirname "$WALLPAPER") && convert -size 1920x1200 radial-gradient:'#2b2e3b-#0a0b0f' $WALLPAPER"
fi

echo "space-theme: applying xfconf settings"
as_cua '
  set -e
  export DBUS_SESSION_BUS_ADDRESS=unix:path=/run/cua-desktop/bus XDG_RUNTIME_DIR=/run/cua-desktop DISPLAY=:1
  set_() {
    xfconf-query -c "$1" -p "$2" -n -t "$3" -s "$4" 2>/dev/null || xfconf-query -c "$1" -p "$2" -s "$4"
  }

  # GTK, icons, fonts and macOS-like window controls.
  set_ xsettings /Net/ThemeName string "$GTK_THEME"
  set_ xsettings /Net/IconThemeName string "$ICON_THEME"
  set_ xsettings /Gtk/CursorThemeName string "$CURSOR_THEME"
  set_ xsettings /Gtk/FontName string "Inter 10"
  set_ xsettings /Xft/Antialias int 1
  set_ xsettings /Xft/Hinting int 1
  set_ xsettings /Xft/HintStyle string hintslight
  set_ xsettings /Xft/RGBA string none
  set_ xsettings /Gtk/ShellShowsMenubar bool true
  set_ xsettings /Gtk/ShellShowsAppmenu bool true
  set_ xsettings /Gtk/Modules string appmenu-gtk-module
  set_ xfwm4 /general/theme string "$GTK_THEME"
  set_ xfwm4 /general/title_font string "Inter Semi-Bold 10"
  set_ xfwm4 /general/title_alignment string center
  set_ xfwm4 /general/button_layout string "CHM|"
  set_ xfwm4 /general/use_compositing bool true
  set_ xfwm4 /general/show_dock_shadow bool true
  set_ xfwm4 /general/show_frame_shadow bool true
  set_ xfwm4 /general/show_popup_shadow bool true
  # Minimal desktop: wallpaper only, with desktop icons hidden.
  for p in $(xfconf-query -c xfce4-desktop -l | grep -E "/last-image$"); do
    set_ xfce4-desktop "$p" string "$WALLPAPER"
    set_ xfce4-desktop "${p%last-image}image-style" int 5
  done
  set_ xfce4-desktop /desktop-icons/style int 0

  # Stage a deterministic one-panel configuration. The host installs it after stopping the container,
  # so xfconfd/session-manager cannot rewrite it during the panel-2 removal.
  PANEL_DIR=~/.config/xfce4/xfconf/xfce-perchannel-xml
  mkdir -p "$PANEL_DIR"
  cat > "$PANEL_DIR/xfce4-panel.theme.xml" <<EOF
<?xml version="1.0" encoding="UTF-8"?>

<channel name="xfce4-panel" version="1.0">
  <property name="configver" type="int" value="2"/>
  <property name="panels" type="array">
    <value type="int" value="1"/>
    <property name="dark-mode" type="bool" value="true"/>
    <property name="panel-1" type="empty">
      <property name="position" type="string" value="p=6;x=0;y=0"/>
      <property name="length" type="uint" value="100"/>
      <property name="position-locked" type="bool" value="true"/>
      <property name="icon-size" type="uint" value="14"/>
      <property name="size" type="uint" value="24"/>
      <property name="background-style" type="uint" value="1"/>
      <property name="background-rgba" type="array">
        <value type="double" value="0.07"/>
        <value type="double" value="0.08"/>
        <value type="double" value="0.10"/>
        <value type="double" value="0.72"/>
      </property>
      <property name="plugin-ids" type="array">
        <value type="int" value="1"/>
        <value type="int" value="23"/>
        <value type="int" value="3"/>
        <value type="int" value="6"/>
        <value type="int" value="8"/>
        <value type="int" value="12"/>
        <value type="int" value="14"/>
      </property>
    </property>
  </property>
  <property name="plugins" type="empty">
    <property name="plugin-1" type="string" value="applicationsmenu">
      <property name="show-button-title" type="bool" value="false"/>
      <property name="button-icon" type="string" value="start-here"/>
    </property>
    <property name="plugin-23" type="string" value="appmenu"/>
    <property name="plugin-3" type="string" value="separator">
      <property name="expand" type="bool" value="true"/>
      <property name="style" type="uint" value="0"/>
    </property>
    <property name="plugin-6" type="string" value="systray">
      <property name="square-icons" type="bool" value="true"/>
    </property>
    <property name="plugin-8" type="string" value="pulseaudio">
      <property name="enable-keyboard-shortcuts" type="bool" value="true"/>
      <property name="show-notifications" type="bool" value="true"/>
    </property>
    <property name="plugin-12" type="string" value="clock"/>
    <property name="plugin-14" type="string" value="actions"/>
  </property>
</channel>
EOF

  # WhiteSur Plank theme, four pinned apps and session autostart.
  mkdir -p ~/.local/share/plank/themes ~/.local/share/applications ~/.config/plank/dock1/launchers ~/.config/autostart
  rm -rf ~/.local/share/plank/themes/WhiteSur-Dark
  cp -a ~/.themes/WhiteSur-Dark/plank ~/.local/share/plank/themes/WhiteSur-Dark
  write_dockitem() {
    printf "[PlankDockItemPreferences]\nLauncher=file://%s\n" "$2" > ~/.config/plank/dock1/launchers/"$1".dockitem
  }
  rm -f ~/.config/plank/dock1/launchers/*.dockitem
  cat > ~/.local/share/applications/tarsbot-finder.desktop <<EOF
[Desktop Entry]
Type=Application
Name=Finder
Exec=thunar /home/cua
Icon=system-file-manager
Terminal=false
StartupWMClass=Thunar
EOF
  cat > ~/.local/share/applications/tarsbot-terminal.desktop <<EOF
[Desktop Entry]
Type=Application
Name=Terminal
Exec=xfce4-terminal
Icon=utilities-terminal
Terminal=false
StartupWMClass=Xfce4-terminal
EOF
  # Keep stable filenames; the dock-items GSettings array below defines display order.
  write_dockitem 40-Finder /home/cua/.local/share/applications/tarsbot-finder.desktop
  write_dockitem 30-Chromium /usr/share/applications/chromium.desktop
  write_dockitem 20-Terminal /home/cua/.local/share/applications/tarsbot-terminal.desktop
  write_dockitem 10-Search /usr/share/applications/xfce4-appfinder.desktop
  cat > ~/.config/autostart/plank.desktop <<EOF
[Desktop Entry]
Type=Application
Name=Plank
Exec=plank
OnlyShowIn=XFCE;
X-GNOME-Autostart-enabled=true
EOF
  # Remove settings written by older script revisions to the wrong relocatable path.
  gsettings reset-recursively net.launchpad.plank.dock.settings:/net/launchpad/plank/dock1/
  G="net.launchpad.plank.dock.settings:/net/launchpad/plank/docks/dock1/"
  gsettings set "$G" theme WhiteSur-Dark
  gsettings set "$G" icon-size 52
  gsettings set "$G" position bottom
  gsettings set "$G" alignment center
  gsettings set "$G" hide-mode intelligent
  gsettings set "$G" hide-delay 200
  gsettings set "$G" auto-pinning false
  gsettings set "$G" lock-items true
  gsettings set "$G" pinned-only false
  gsettings set "$G" zoom-enabled true
  gsettings set "$G" zoom-percent 130

  # Soft terminal palette and a readable monospace font.
  RC=~/.config/xfce4/terminal/terminalrc
  mkdir -p "$(dirname "$RC")"
  printf "%s\n" \
    "[Configuration]" \
    "FontName=Fira Code 11" \
    "ColorForeground=#e5e7eb" \
    "ColorBackground=#1c1c1e" \
    "ColorCursor=#e5e7eb" \
    "MiscCursorBlinks=TRUE" \
    "ScrollingBar=TERMINAL_SCROLLBAR_NONE" > "$RC"

'

echo "space-theme: installing panel config and restarting Space"
IMAGE="$(docker inspect -f '{{.Config.Image}}' "$NAME")"
docker stop "$NAME" >/dev/null
docker run --rm --volumes-from "$NAME" --entrypoint bash "$IMAGE" -c '
  dir=/home/cua/.config/xfce4/xfconf/xfce-perchannel-xml
  mv "$dir/xfce4-panel.theme.xml" "$dir/xfce4-panel.xml"
  chown 1000:1000 "$dir/xfce4-panel.xml"
'
docker start "$NAME" >/dev/null

PORT="$(docker port "$NAME" 3211/tcp | sed -n '1s/.*://p')"
deadline=$((SECONDS + 120))
until [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "http://127.0.0.1:${PORT:-3211}/viewer/" || true)" = "200" ]; do
  [ "$SECONDS" -lt "$deadline" ] || { echo "space-theme: timeout waiting for restarted Space" >&2; exit 1; }
  sleep 2
done
echo "space-theme: finalizing Plank launcher order"
as_cua '
  set -e
  export DBUS_SESSION_BUS_ADDRESS=unix:path=/run/cua-desktop/bus XDG_RUNTIME_DIR=/run/cua-desktop DISPLAY=:1
  pkill -x plank 2>/dev/null || true
  deadline=$((SECONDS + 10))
  while pgrep -x plank >/dev/null; do
    [ "$SECONDS" -lt "$deadline" ] || { echo "space-theme: timeout stopping Plank" >&2; exit 1; }
    sleep 1
  done
  G="net.launchpad.plank.dock.settings:/net/launchpad/plank/docks/dock1/"
  gsettings set "$G" dock-items "[\"40-Finder.dockitem\", \"30-Chromium.dockitem\", \"20-Terminal.dockitem\", \"10-Search.dockitem\"]"
  setsid -f plank
  deadline=$((SECONDS + 10))
  until pgrep -x plank >/dev/null; do
    [ "$SECONDS" -lt "$deadline" ] || { echo "space-theme: timeout starting Plank" >&2; exit 1; }
    sleep 1
  done
'
echo "space-theme: done (theme=$GTK_THEME icons=$ICON_THEME cursor=$CURSOR_THEME)"
