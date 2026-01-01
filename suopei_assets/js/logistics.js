/**
 * 物流官网模块
 * 管理GOFO、UNINI、USPS三个物流官网按钮的弹窗功能
 */

/**
 * 物流官网URL配置
 */
const LOGISTICS_URLS = {
    'GOFO': 'https://www.gofo.com/us/track?searchID=',
    'UNINI': 'https://www.uniuni.com//tracking#tracking-detail?no=',
    'USPS': 'https://zh-tools.usps.com/go/TrackConfirmAction_input'
};

/**
 * 打开物流官网弹窗
 * @param {string} type - 物流类型：'GOFO'、'UNINI'、'USPS'
 */
function openLogisticsModal(type) {
    const modal = document.getElementById('logisticsModal');
    const titleEl = document.getElementById('logisticsModalTitle');
    const iframeEl = document.getElementById('logisticsModalIframe');
    
    if (!modal || !titleEl || !iframeEl) {
        console.error('物流弹窗元素未找到');
        return;
    }
    
    const url = LOGISTICS_URLS[type];
    if (!url) {
        console.error('未知的物流类型:', type);
        return;
    }
    
    titleEl.textContent = `${type} 物流官网`;
    iframeEl.src = url;
    
    modal.classList.remove('hidden');
    requestAnimationFrame(() => {
        modal.classList.add('active');
    });
}

/**
 * 关闭物流官网弹窗
 */
function closeLogisticsModal() {
    const modal = document.getElementById('logisticsModal');
    const iframeEl = document.getElementById('logisticsModalIframe');
    
    if (!modal) return;
    
    modal.classList.remove('active');
    setTimeout(() => {
        modal.classList.add('hidden');
        if (iframeEl) {
            iframeEl.src = '';
        }
    }, 300);
}

/**
 * 初始化物流官网模块
 * 绑定ESC键关闭弹窗事件
 */
function initLogisticsModule() {
    // ESC键关闭物流官网弹窗
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            const logisticsModal = document.getElementById('logisticsModal');
            if (logisticsModal && logisticsModal.classList.contains('active')) {
                closeLogisticsModal();
            }
        }
    });
}

// 暴露函数到全局作用域，确保HTML中的onclick能正确调用
if (typeof window !== 'undefined') {
    window.openLogisticsModal = openLogisticsModal;
    window.closeLogisticsModal = closeLogisticsModal;
}

// DOM加载完成后初始化
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initLogisticsModule);
} else {
    initLogisticsModule();
}

