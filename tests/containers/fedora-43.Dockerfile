FROM fedora:43
RUN dnf install -y --setopt=install_weak_deps=False gnome-shell python3-gobject procps-ng mesa-dri-drivers \
      xorg-x11-server-Xwayland dbus-daemon && dnf clean all
RUN mkdir -m 1777 -p /tmp/.X11-unix && useradd -m -u 1000 tester
USER tester
WORKDIR /home/tester
