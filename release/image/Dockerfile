# The base image for the FAKE backend, on a machine that can pull from Docker Hub (a Mac
# with Docker, CI). It is the same provisioning as the VM image, minus the kernel:
#
#   docker build -t desolate/base:latest -f release/image/Dockerfile release
#
# Where Docker Hub is out of reach (the agent's sandbox), release/image/build.sh builds the
# same thing from the Ubuntu archive and imports it.
#
# UNTESTED as of this commit: the sandbox it was written in cannot pull ubuntu:24.04.
FROM ubuntu:24.04
COPY pins.env /opt/desolate-build/pins.env
COPY image/provision.sh /opt/desolate-build/image/provision.sh
COPY image/locks /opt/desolate-build/image/locks
# --build-arg DESOLATE_IMAGE_EDITOR=none: an image without the editor server, for a builder
# that cannot reach GitHub's releases. Not given, a build that cannot fetch the editor fails.
ARG DESOLATE_IMAGE_EDITOR=
RUN DESOLATE_IMAGE_KIND=container DESOLATE_IMAGE_EDITOR=$DESOLATE_IMAGE_EDITOR bash /opt/desolate-build/image/provision.sh && rm -rf /opt/desolate-build
CMD ["sleep", "infinity"]
