FROM ubuntu:24.04
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      gnome-shell gjs dbus dbus-user-session libgl1-mesa-dri libglib2.0-bin \
      gir1.2-soup-3.0 gir1.2-adw-1 fonts-cantarell fonts-dejavu-core python3 python3-gi gir1.2-gdkpixbuf-2.0 \
      xwayland procps ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN (userdel -r ubuntu 2>/dev/null || true) && useradd -m -u 1000 tester
RUN mkdir -m 1777 -p /tmp/.X11-unix
USER tester
WORKDIR /home/tester
