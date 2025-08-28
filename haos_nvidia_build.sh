#!/bin/bash

# ===================================================
# One-Click Custom HAOS Build mit NVIDIA RTX4060 Support
# ===================================================

set -e  # Bei Fehlern stoppen

echo "🚀 Starting Custom HAOS Build with NVIDIA RTX4060 Support..."

# Variablen
NVIDIA_DRIVER_VERSION="555.58.02"
CUDA_VERSION="12.6.0"
WORK_DIR="$(pwd)/haos-nvidia-build"
HAOS_DIR="$WORK_DIR/operating-system"

# Farben für Output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo_info() { echo -e "${GREEN}[INFO]${NC} $1"; }
echo_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
echo_error() { echo -e "${RED}[ERROR]${NC} $1"; }

# ===================================================
# Phase 1: Systemprüfung und Setup
# ===================================================

echo_info "Phase 1: Systemprüfung und Setup"

# Voraussetzungen prüfen
command -v git >/dev/null 2>&1 || { echo_error "git wird benötigt. Installieren Sie: sudo apt install git"; exit 1; }
command -v docker >/dev/null 2>&1 || { echo_error "docker wird benötigt. Installieren Sie: sudo apt install docker.io"; exit 1; }
command -v wget >/dev/null 2>&1 || { echo_error "wget wird benötigt. Installieren Sie: sudo apt install wget"; exit 1; }

# Docker Berechtigung prüfen
if ! docker ps >/dev/null 2>&1; then
    echo_warn "Docker Permission fehlt. Fügen Sie Ihren User zur docker Gruppe hinzu:"
    echo "sudo usermod -aG docker $USER"
    echo "Dann System neustarten und Script erneut ausführen."
    exit 1
fi

# Arbeitsverzeichnis erstellen
mkdir -p "$WORK_DIR"
cd "$WORK_DIR"

# ===================================================
# Phase 2: Source Code Setup
# ===================================================

echo_info "Phase 2: Source Code Setup"

# HAOS Source klonen
if [ ! -d "operating-system" ]; then
    echo_info "Klone Home Assistant Operating System..."
    git clone https://github.com/home-assistant/operating-system/
else
    echo_info "HAOS Repository bereits vorhanden"
fi

cd "$HAOS_DIR"
git submodule update --init

# NVIDIA Open Kernel Module klonen
cd "$WORK_DIR"
if [ ! -d "open-gpu-kernel-modules" ]; then
    echo_info "Klone NVIDIA Open Kernel Modules..."
    git clone https://github.com/NVIDIA/open-gpu-kernel-modules.git
else
    echo_info "NVIDIA Repository bereits vorhanden"
fi

cd open-gpu-kernel-modules
git checkout "$NVIDIA_DRIVER_VERSION"

# ===================================================
# Phase 3: Buildroot Package Erstellung
# ===================================================

echo_info "Phase 3: Buildroot Package Erstellung"

cd "$HAOS_DIR"

# Package Verzeichnisse erstellen
mkdir -p buildroot-external/package/nvidia-open-driver
mkdir -p buildroot-external/package/cuda-runtime
mkdir -p buildroot-external/board/nvidia

# NVIDIA Open Driver Package Config
cat > buildroot-external/package/nvidia-open-driver/Config.in << 'EOF'
config BR2_PACKAGE_NVIDIA_OPEN_DRIVER
    bool "nvidia-open-driver"
    depends on BR2_LINUX_KERNEL
    depends on BR2_x86_64
    select BR2_PACKAGE_HOST_OPENSSL
    help
      NVIDIA Open Kernel Modules for RTX 4060 support
      
      This package provides the open-source NVIDIA kernel
      modules required for RTX 4060 GPU acceleration.
      
      https://github.com/NVIDIA/open-gpu-kernel-modules
EOF

# NVIDIA Open Driver Package Makefile
cat > buildroot-external/package/nvidia-open-driver/nvidia-open-driver.mk << 'EOF'
################################################################################
#
# nvidia-open-driver
#
################################################################################

NVIDIA_OPEN_DRIVER_VERSION = 555.58.02
NVIDIA_OPEN_DRIVER_SITE = $(call github,NVIDIA,open-gpu-kernel-modules,$(NVIDIA_OPEN_DRIVER_VERSION))
NVIDIA_OPEN_DRIVER_LICENSE = GPL-2.0, MIT
NVIDIA_OPEN_DRIVER_LICENSE_FILES = COPYING

NVIDIA_OPEN_DRIVER_MODULE_SUBDIRS = kernel-open
NVIDIA_OPEN_DRIVER_MODULE_MAKE_OPTS = \
    KERNEL_UNAME=$(LINUX_VERSION_PROBED) \
    NV_KERNEL_SOURCES=$(LINUX_DIR) \
    NV_KERNEL_OUTPUT=$(LINUX_DIR) \
    NV_BUILD_TYPE=release

define NVIDIA_OPEN_DRIVER_CONFIGURE_CMDS
    $(MAKE) -C $(@D) $(TARGET_CONFIGURE_OPTS) \
        $(NVIDIA_OPEN_DRIVER_MODULE_MAKE_OPTS) \
        -f Makefile nv-kernel.o_binary
endef

$(eval $(kernel-module))
$(eval $(generic-package))
EOF

# CUDA Runtime Package Config
cat > buildroot-external/package/cuda-runtime/Config.in << 'EOF'
config BR2_PACKAGE_CUDA_RUNTIME
    bool "cuda-runtime"
    depends on BR2_PACKAGE_NVIDIA_OPEN_DRIVER
    depends on BR2_x86_64
    help
      CUDA Runtime Libraries for GPU computing
      
      This package provides CUDA runtime libraries
      required for GPU acceleration workloads.
      
      https://developer.nvidia.com/cuda-downloads
EOF

# CUDA Runtime Package Makefile
cat > buildroot-external/package/cuda-runtime/cuda-runtime.mk << 'EOF'
################################################################################
#
# cuda-runtime
#
################################################################################

CUDA_RUNTIME_VERSION = 12.6.0
CUDA_RUNTIME_SITE = https://developer.download.nvidia.com/compute/cuda/$(CUDA_RUNTIME_VERSION)/local_installers
CUDA_RUNTIME_SOURCE = cuda_$(CUDA_RUNTIME_VERSION)_560.28.03_linux.run
CUDA_RUNTIME_LICENSE = NVIDIA Software License Agreement
CUDA_RUNTIME_REDISTRIBUTE = NO

define CUDA_RUNTIME_EXTRACT_CMDS
    cd $(@D) && sh $(CUDA_RUNTIME_DL_DIR)/$(CUDA_RUNTIME_SOURCE) \
        --silent --toolkit --override --no-opengl-libs \
        --tmpdir=$(@D)/tmp --extract=$(@D)
endef

define CUDA_RUNTIME_INSTALL_TARGET_CMDS
    mkdir -p $(TARGET_DIR)/usr/local/cuda/lib64
    mkdir -p $(TARGET_DIR)/usr/local/cuda/bin
    cp -r $(@D)/cuda-toolkit/lib64/* $(TARGET_DIR)/usr/local/cuda/lib64/
    cp -r $(@D)/cuda-toolkit/bin/nvcc $(TARGET_DIR)/usr/local/cuda/bin/
    cp -r $(@D)/cuda-toolkit/bin/nvidia-smi $(TARGET_DIR)/usr/local/cuda/bin/
    ln -sf /usr/local/cuda/lib64 $(TARGET_DIR)/usr/lib64
    echo "/usr/local/cuda/lib64" > $(TARGET_DIR)/etc/ld.so.conf.d/cuda.conf
endef

$(eval $(generic-package))
EOF

# ===================================================
# Phase 4: Board Configuration
# ===================================================

echo_info "Phase 4: Board Configuration"

# Custom Board Config erstellen
cp buildroot-external/configs/generic_x86_64_defconfig \
   buildroot-external/configs/nvidia_x86_64_defconfig

# Board Config erweitern
cat >> buildroot-external/configs/nvidia_x86_64_defconfig << 'EOF'

# NVIDIA GPU Support
BR2_PACKAGE_NVIDIA_OPEN_DRIVER=y
BR2_PACKAGE_CUDA_RUNTIME=y

# Kernel Module Support
BR2_LINUX_KERNEL_NEEDS_HOST_OPENSSL=y
BR2_PACKAGE_HOST_OPENSSL=y

# GPU Dependencies
BR2_PACKAGE_LIBDRM=y
BR2_PACKAGE_MESA3D=y
BR2_PACKAGE_MESA3D_DRI_DRIVER_IRIS=y
BR2_PACKAGE_MESA3D_OPENGL_EGL=y
BR2_PACKAGE_MESA3D_OPENGL_ES=y

# Container Runtime Support
BR2_PACKAGE_DOCKER_ENGINE=y
BR2_PACKAGE_CONTAINERD=y
BR2_PACKAGE_RUNC=y

# Additional Tools
BR2_PACKAGE_HTOP=y
BR2_PACKAGE_NANO=y
BR2_PACKAGE_LSOF=y
EOF

# Kernel Config Fragment
cat > buildroot-external/board/nvidia/linux.config << 'EOF'
# NVIDIA GPU Support
CONFIG_DRM=y
CONFIG_DRM_NOUVEAU=n
CONFIG_NOUVEAU_LEGACY_CTX_SUPPORT=n

# PCI Support
CONFIG_PCI=y
CONFIG_PCI_MSI=y
CONFIG_HOTPLUG_PCI=y

# IOMMU Support
CONFIG_IOMMU_SUPPORT=y
CONFIG_INTEL_IOMMU=y
CONFIG_AMD_IOMMU=y

# Module Support
CONFIG_MODULES=y
CONFIG_MODULE_UNLOAD=y
CONFIG_MODVERSIONS=y
CONFIG_MODULE_SRCVERSION_ALL=y

# ACPI Support
CONFIG_ACPI=y
CONFIG_ACPI_HOTPLUG_MEMORY=y

# Security
CONFIG_SECURITY=y
CONFIG_SECURITY_NETWORK=y
EOF

# Kernel Config in defconfig einbinden
echo 'BR2_LINUX_KERNEL_CONFIG_FRAGMENT_FILES="$(BR2_EXTERNAL_HASSOS_PATH)/board/nvidia/linux.config"' >> \
buildroot-external/configs/nvidia_x86_64_defconfig

# Package Integration in Config.in
if ! grep -q "NVIDIA GPU Support" buildroot-external/Config.in; then
    cat >> buildroot-external/Config.in << 'EOF'

menu "NVIDIA GPU Support"
    source "$BR2_EXTERNAL_HASSOS_PATH/package/nvidia-open-driver/Config.in"
    source "$BR2_EXTERNAL_HASSOS_PATH/package/cuda-runtime/Config.in"
endmenu
EOF
fi

# ===================================================
# Phase 5: Build Process
# ===================================================

echo_info "Phase 5: Build Process starten..."

# Docker Container Permission Fix
sudo chown -R $(id -u):$(id -g) .

echo_info "Starte Build Container und Build Process..."
echo_warn "Dies kann 1-2 Stunden dauern!"

# Build ausführen
./scripts/enter.sh make nvidia_x86_64_defconfig
./scripts/enter.sh make

# ===================================================
# Phase 6: Post-Build Setup
# ===================================================

echo_info "Phase 6: Post-Build Setup"

# Docker Runtime Config für GPU Support
cat > nvidia-docker-daemon.json << 'EOF'
{
    "default-runtime": "nvidia",
    "runtimes": {
        "nvidia": {
            "path": "nvidia-container-runtime",
            "runtimeArgs": []
        }
    }
}
EOF

# Verifikations-Script erstellen
cat > verify_nvidia_haos.sh << 'EOF'
#!/bin/bash
echo "=== NVIDIA HAOS Verification ==="
echo "Kernel Modules:"
lsmod | grep nvidia
echo -e "\nNVIDIA Device Nodes:"
ls -la /dev/nvidia*
echo -e "\nGPU Information:"
nvidia-smi
echo -e "\nCUDA Version:"
nvcc --version
echo -e "\nDocker GPU Support:"
docker run --rm --gpus all nvidia/cuda:11.0-base nvidia-smi
EOF

chmod +x verify_nvidia_haos.sh

# ===================================================
# Abschluss
# ===================================================

echo_info "Build abgeschlossen! 🎉"
echo ""
echo "📁 Build Output: $(pwd)/release/"
echo "💿 Image: haos_nvidia_x86_64-*.img.xz"
echo ""
echo "🔧 Nächste Schritte:"
echo "1. Image auf USB/SSD flashen:"
echo "   xz -d release/haos_nvidia_x86_64-*.img.xz"
echo "   sudo dd if=release/haos_nvidia_x86_64-*.img of=/dev/sdX bs=4M status=progress"
echo ""
echo "2. Nach dem Boot GPU Support prüfen:"
echo "   ./verify_nvidia_haos.sh"
echo ""
echo "3. Docker Daemon für GPU Support konfigurieren:"
echo "   sudo cp nvidia-docker-daemon.json /etc/docker/daemon.json"
echo "   sudo systemctl restart docker"
echo ""
echo_info "Custom HAOS Build mit RTX 4060 Support erfolgreich erstellt! ✅"
