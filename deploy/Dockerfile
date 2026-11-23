# Use PyTorch + CUDA runtime base, so the AI worker (SAM / μSAM) can use the GPU
FROM docker.io/pytorch/pytorch:2.6.0-cuda12.4-cudnn9-runtime

# Set non-interactive mode
ARG DEBIAN_FRONTEND=noninteractive

# Install system dependencies in a single layer
COPY requirements.apt /tmp/requirements.apt
RUN apt-get update && apt-get install -y --no-install-recommends \
    $(tr '\n' ' ' < /tmp/requirements.apt) \
    sudo wget git curl zsh \
 && rm -rf /var/lib/apt/lists/* \
 && rm /tmp/requirements.apt

# Node.js for the Next.js frontend (Next 16 needs Node 20.9+)
ARG NODE_VERSION=22.20.0
RUN curl -fsSL https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.gz \
    | tar -xz -C /opt \
 && ln -s /opt/node-v${NODE_VERSION}-linux-x64 /opt/node
ENV PATH="/opt/node/bin:${PATH}"

# uv for the Python backend (it installs Python 3.12 and the backend's packages itself)
RUN python -m pip install --no-cache-dir uv==0.11.32

# Create non-root user
ARG USERNAME=patrick
ARG USER_UID=2828
ARG USER_GID=1735
RUN groupadd --gid $USER_GID $USERNAME \
 && useradd --uid $USER_UID --gid $USER_GID -m $USERNAME \
 && echo "$USERNAME ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/$USERNAME \
 && chmod 0440 /etc/sudoers.d/$USERNAME

# Switch to non-root early
USER $USERNAME
ENV HOME=/home/$USERNAME
WORKDIR /home/$USERNAME
ENV PATH="/home/$USERNAME/.local/bin:${PATH}"

# Install Oh My Zsh for the user (non-interactive)
RUN sh -c "$(wget -qO- https://raw.githubusercontent.com/ohmyzsh/ohmyzsh/master/tools/install.sh)" "" --unattended

# Set login shell for the user (needs root)
USER root
RUN chsh -s /usr/bin/zsh $USERNAME

# chown home directory to the user
RUN chown -R $USERNAME:$USERNAME /home/$USERNAME
USER $USERNAME
