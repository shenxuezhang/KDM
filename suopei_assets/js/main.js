/**
 * 主入口模块
 * 包含虚拟滚动管理器、表单处理、渲染逻辑、初始化等核心功能
 */

// 全局状态对象
const ListState = {
    data: [],
    totalCount: 0,
    pagination: {
        page: 1,
        pageSize: parseInt(localStorage.getItem('wh_claims_pageSize')) || 20,
        pageSizeOptions: [20, 50, 100, 200]
    },
    filters: {
        status: 'all',
        type: 'all',
        search: '',              // 搜索关键词
        searchMode: 'fuzzy',     // 搜索模式：fuzzy（模糊）或 exact（精确）
        searchField: 'all',      // 搜索字段：'all'（全部字段）或指定字段名
        advancedSearch: null     // 高级搜索条件（对象数组）
    },
    sorting: {
        col: 'entry_date',
        asc: false
    },
    isLoading: false,
    isLargeDataset: false,
    loadedRanges: []
};

// 全局数据库数组已在database.js中定义，此处不重复声明
// 如果需要访问database变量，它已经在database.js模块中声明为全局变量

// 虚拟滚动管理器实例（全局变量）
let virtualScrollManager = null;

// 暴露到全局作用域，供HTML中的代码访问
if (typeof window !== 'undefined') {
    window.virtualScrollManager = null;
}

// 生成UUID
function generateUUID() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
        const r = Math.random() * 16 | 0;
        const v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}

// 虚拟滚动管理器类（性能优化版）
class VirtualScrollManager {
    constructor(containerId, itemHeight = 72) {
        this.container = document.getElementById(containerId);
        this.itemHeight = itemHeight;
        this.visibleCount = 0;
        this.bufferCount = 3; // 增加缓冲区大小，提升滚动流畅度
        this.startIndex = 0;
        this.endIndex = 0;
        this.scrollTop = 0;
        this.totalItems = 0;
        this.data = [];
        this.domPool = [];
        this.maxPoolSize = 100; // 增加DOM池大小，减少创建/销毁开销
        this.isLoading = false;
        
        this.topSpacer = null;
        this.bottomSpacer = null;
        this.boundHandleScroll = null;
        this.eventListeners = new Map();
        this.delegationHandler = null;
        
        // 【性能优化】节流和防抖相关
        this.scrollThrottleTimer = null;
        this.renderAnimationFrame = null;
        this.lastRenderTime = 0;
        this.renderInterval = 16; // 约60fps的渲染间隔

        this.initContainer();
        this.bindEvents();
        this.setupEventDelegation();
    }
    
    initContainer() {
        this.container.innerHTML = '';
        
        this.topSpacer = document.createElement('tr');
        this.topSpacer.className = 'virtual-spacer-top';
        this.topSpacer.style.height = '0px';
        this.topSpacer.style.visibility = 'hidden';
        
        this.bottomSpacer = document.createElement('tr');
        this.bottomSpacer.className = 'virtual-spacer-bottom';
        this.bottomSpacer.style.height = '0px';
        this.bottomSpacer.style.visibility = 'hidden';

        this.container.appendChild(this.topSpacer);
        this.container.appendChild(this.bottomSpacer);
    }
    
    bindEvents() {
        // 【性能优化】使用节流优化滚动事件处理
        this.boundHandleScroll = (e) => {
            const now = Date.now();
            this.scrollTop = e.target.scrollTop;
            
            // 节流：限制更新频率
            if (now - this.lastRenderTime < this.renderInterval) {
                if (this.scrollThrottleTimer) {
                    cancelAnimationFrame(this.scrollThrottleTimer);
                }
                this.scrollThrottleTimer = requestAnimationFrame(() => {
                    this.updateRenderRange();
                    this.checkLoadMore();
                    this.lastRenderTime = Date.now();
                });
            } else {
                if (this.renderAnimationFrame) {
                    cancelAnimationFrame(this.renderAnimationFrame);
                }
                this.renderAnimationFrame = requestAnimationFrame(() => {
                    this.updateRenderRange();
                    this.checkLoadMore();
                    this.lastRenderTime = Date.now();
                });
            }
        };
        
        this.container.addEventListener('scroll', this.boundHandleScroll, { passive: true });
        this.eventListeners.set('scroll', {
            element: this.container,
            event: 'scroll',
            handler: this.boundHandleScroll
        });
    }
    
    setupEventDelegation() {
        if (!this.container) return;
        
        if (this.delegationHandler) {
            this.container.removeEventListener('click', this.delegationHandler);
        }
        
        this.delegationHandler = (e) => {
            if (e.target.closest('tr[data-item-id]')) {
                const tr = e.target.closest('tr[data-item-id]');
                const checkbox = tr.querySelector('.row-checkbox');
                if (e.target === checkbox || checkbox && checkbox.contains(e.target)) {
                    return;
                }
                if (checkbox) {
                    checkbox.checked = !checkbox.checked;
                    updateSelectAllState();
                }
            }
        };
        
        this.container.addEventListener('click', this.delegationHandler);
        this.eventListeners.set('click', {
            element: this.container,
            event: 'click',
            handler: this.delegationHandler
        });
    }

    updateRenderRange() {
        let newStartIndex = Math.floor(this.scrollTop / this.itemHeight) - this.bufferCount;
        newStartIndex = Math.max(0, newStartIndex);

        const visibleHeight = this.container.clientHeight;
        this.visibleCount = Math.ceil(visibleHeight / this.itemHeight);

        let newEndIndex = newStartIndex + this.visibleCount + (this.bufferCount * 2);
        newEndIndex = Math.min(this.totalItems, newEndIndex);

        // 【性能优化】只在范围真正改变时才重新渲染
        if (newStartIndex !== this.startIndex || newEndIndex !== this.endIndex) {
            const oldStartIndex = this.startIndex;
            const oldEndIndex = this.endIndex;
            
            this.startIndex = newStartIndex;
            this.endIndex = newEndIndex;
            
            // 如果只是小范围的滚动，使用增量更新而非全量重渲染
            if (oldStartIndex !== -1 && 
                Math.abs(newStartIndex - oldStartIndex) < this.visibleCount * 2 &&
                Math.abs(newEndIndex - oldEndIndex) < this.visibleCount * 2) {
                this.renderVisibleItemsIncremental(oldStartIndex, oldEndIndex);
            } else {
                this.renderVisibleItems();
            }
        }
    }
    
    renderVisibleItems() {
        const visibleData = this.data.slice(this.startIndex, this.endIndex);
        
        const topHeight = this.startIndex * this.itemHeight;
        const bottomHeight = (this.totalItems - this.endIndex) * this.itemHeight;

        this.topSpacer.style.height = `${topHeight}px`;
        this.bottomSpacer.style.height = `${bottomHeight}px`;
        
        const actualColspan = visibleColumns.length + 2;
        this.topSpacer.innerHTML = `<td colspan="${actualColspan}" style="padding:0; border:none;"></td>`;
        this.bottomSpacer.innerHTML = `<td colspan="${actualColspan}" style="padding:0; border:none;"></td>`;

        // 【性能优化】批量移除DOM节点
        const rows = Array.from(this.container.children);
        const fragmentForPool = document.createDocumentFragment();
        rows.forEach(node => {
            if (node !== this.topSpacer && node !== this.bottomSpacer) {
                this.container.removeChild(node);
                if (this.domPool.length < this.maxPoolSize) {
                    this.domPool.push(node);
                }
            }
        });

        // 【性能优化】使用 DocumentFragment 批量插入
        const fragment = document.createDocumentFragment();
        
        visibleData.forEach((item, index) => {
            const actualIndex = this.startIndex + index;
            const tr = this.createOrReuseRow(item, actualIndex);
            fragment.appendChild(tr);
        });

        this.container.insertBefore(fragment, this.bottomSpacer);
    }
    
    // 【性能优化】增量渲染：只更新变化的行
    renderVisibleItemsIncremental(oldStartIndex, oldEndIndex) {
        const topHeight = this.startIndex * this.itemHeight;
        const bottomHeight = (this.totalItems - this.endIndex) * this.itemHeight;

        this.topSpacer.style.height = `${topHeight}px`;
        this.bottomSpacer.style.height = `${bottomHeight}px`;
        
        const actualColspan = visibleColumns.length + 2;
        this.topSpacer.innerHTML = `<td colspan="${actualColspan}" style="padding:0; border:none;"></td>`;
        this.bottomSpacer.innerHTML = `<td colspan="${actualColspan}" style="padding:0; border:none;"></td>`;

        // 找出需要移除的行
        const rows = Array.from(this.container.children);
        rows.forEach(node => {
            if (node !== this.topSpacer && node !== this.bottomSpacer) {
                const nodeIndex = parseInt(node.dataset.index);
                if (nodeIndex < this.startIndex || nodeIndex >= this.endIndex) {
                    this.container.removeChild(node);
                    if (this.domPool.length < this.maxPoolSize) {
                        this.domPool.push(node);
                    }
                }
            }
        });

        // 找出需要添加的行
        const fragment = document.createDocumentFragment();
        const existingIndices = new Set(
            Array.from(this.container.children)
                .filter(node => node !== this.topSpacer && node !== this.bottomSpacer)
                .map(node => parseInt(node.dataset.index))
        );

        const visibleData = this.data.slice(this.startIndex, this.endIndex);
        visibleData.forEach((item, index) => {
            const actualIndex = this.startIndex + index;
            if (!existingIndices.has(actualIndex)) {
                const tr = this.createOrReuseRow(item, actualIndex);
                fragment.appendChild(tr);
            }
        });

        if (fragment.hasChildNodes()) {
            // 找到正确的插入位置
            const insertBefore = Array.from(this.container.children).find(node => {
                if (node === this.topSpacer || node === this.bottomSpacer) return false;
                const nodeIndex = parseInt(node.dataset.index);
                return nodeIndex >= this.startIndex;
            });
            this.container.insertBefore(fragment, insertBefore || this.bottomSpacer);
        }
    }
    
    createOrReuseRow(item, index) {
        let tr;
        if (this.domPool.length > 0) {
            tr = this.domPool.pop();
            const newTr = tr.cloneNode(false);
            tr = newTr;
        } else {
            tr = document.createElement('tr');
        }
        
        tr.className = 'group hover:bg-blue-50/40 transition-colors border-b border-slate-50 last:border-0';
        tr.dataset.itemId = item.id;
        tr.dataset.index = index;
        this.renderRowContent(tr, item);
        return tr;
    }
    
    renderRowContent(tr, item) {
        const symbol = item.currency === 'CNY' ? '¥' : (item.currency === 'EUR' ? '€' : (item.currency === 'GBP' ? '£' : '$'));
        const colConfigs = {};
        TABLE_COLUMNS.forEach(col => colConfigs[col.key] = col);
        const cells = [];
        
        // 【搜索功能增强】获取搜索关键词用于高亮
        const searchTerm = ListState.filters.search || '';
        const shouldHighlight = searchTerm.trim() && ListState.filters.searchMode !== 'exact';
        
        const checkboxTd = document.createElement('td');
        checkboxTd.className = 'erp-td text-center w-12 pl-4';
        checkboxTd.onclick = (e) => e.stopPropagation();
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.className = 'row-checkbox w-4 h-4 text-emerald-600 rounded border-slate-300 focus:ring-emerald-500 cursor-pointer bg-slate-50 dark:bg-slate-700 dark:border-slate-600';
        checkbox.value = item.id;
        checkbox.onclick = updateSelectAllState;
        checkboxTd.appendChild(checkbox);
        cells.push(checkboxTd);
        
        visibleColumns.forEach(key => {
            const td = document.createElement('td');
            const col = colConfigs[key];
            td.className = 'erp-td';
            td.style.minWidth = col.minW;
            let content = item[key] || '';
            let style = '';
            
            if (key === 'entry_date' || key === 'ship_date' || key === 'created_at') {
                content = formatDateTimeDisplay(content);
            } else if (key === 'order_no') {
                style = 'font-bold text-blue-600';
            } else if (key === 'process_status') {
                content = getStatusBadge(content);
            } else if (key === 'val_amount' || key === 'claim_total') {
                if (hasPermission('can_view_money')) {
                    content = `<span class="font-mono">${symbol}${parseFloat(content).toFixed(2)}</span>`;
                    if (key === 'claim_total') style = 'font-bold text-emerald-600';
                } else {
                    content = `<span class="font-mono text-slate-400">***.${symbol}</span>`;
                    style = 'font-bold text-slate-400';
                }
            } else if (key === 'description') {
                content = `<div class="max-w-[200px] truncate" title="${content}">${content}</div>`;
            }
            
            // 【搜索功能增强】搜索结果高亮显示（仅在模糊搜索模式下）
            if (shouldHighlight && content && typeof content === 'string' && !content.includes('<')) {
                content = highlightSearchTerm(content, searchTerm);
            }
            
            if (col.center) style += ' text-center';
            if (style) td.className += ` ${style}`;
            td.innerHTML = content;
            cells.push(td);
        });
        
        const actionTd = document.createElement('td');
        actionTd.className = 'erp-td pr-6 text-center';
        actionTd.style.width = '120px';
        actionTd.style.minWidth = '120px';
        actionTd.onclick = (e) => e.stopPropagation();
        const actionDiv = document.createElement('div');
        actionDiv.className = 'flex items-center justify-center space-x-1';
        
        if (hasPermission('can_edit')) actionDiv.appendChild(this.createActionButton('edit', item.id, '编辑'));
        if (hasPermission('can_edit')) actionDiv.appendChild(this.createActionButton('status', item.id, '更新状态'));
        if (hasPermission('can_export')) actionDiv.appendChild(this.createActionButton('download', item.id, '导出'));
        if (hasPermission('can_delete')) actionDiv.appendChild(this.createActionButton('delete', item.id, '删除'));
        
        actionTd.appendChild(actionDiv);
        cells.push(actionTd);
        cells.forEach(cell => tr.appendChild(cell));
    }
    
    createActionButton(type, itemId, title) {
        const btn = document.createElement('button');
        btn.title = title;
        switch(type) {
            case 'edit':
                btn.className = 'action-btn hover:bg-blue-100 text-slate-400 hover:text-blue-600';
                btn.innerHTML = '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z"></path></svg>';
                btn.onclick = () => editRowById(itemId);
                break;
            case 'status':
                btn.className = 'action-btn hover:bg-purple-100 text-slate-400 hover:text-purple-600';
                btn.innerHTML = '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>';
                btn.onclick = () => openStatusModal(itemId);
                break;
            case 'download':
                btn.className = 'action-btn hover:bg-slate-200 text-slate-400 hover:text-slate-700';
                btn.innerHTML = '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"></path></svg>';
                btn.onclick = () => downloadRowById(itemId);
                break;
            case 'delete':
                btn.className = 'action-btn hover:bg-red-100 text-slate-400 hover:text-red-500';
                btn.innerHTML = '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path></svg>';
                btn.onclick = () => deleteRowById(itemId);
                break;
        }
        return btn;
    }
    
    updateData(data, totalItems) {
        this.data = data;
        this.totalItems = totalItems;
        this.scrollTop = this.container.scrollTop;
        this.startIndex = -1;
        this.updateRenderRange();
    }
    
    checkLoadMore() {
        if (this.data.length >= this.totalItems || this.isLoading) return;
        const scrollBottom = this.scrollTop + this.container.clientHeight;
        const totalHeight = this.totalItems * this.itemHeight;
        if (totalHeight - scrollBottom < 200) {
            this.loadMoreData();
        }
    }
    
    async loadMoreData() {
        if (this.isLoading) return;
        this.isLoading = true;
        try {
            ListState.pagination.page += 1;
            await fetchTableData(true);
            this.updateData(ListState.data, ListState.totalCount);
        } catch (error) {
            console.error('加载更多数据失败:', error);
        } finally {
            this.isLoading = false;
        }
    }
    
    destroy() {
        // 【性能优化】清理所有定时器和动画帧
        if (this.scrollThrottleTimer) {
            cancelAnimationFrame(this.scrollThrottleTimer);
            this.scrollThrottleTimer = null;
        }
        if (this.renderAnimationFrame) {
            cancelAnimationFrame(this.renderAnimationFrame);
            this.renderAnimationFrame = null;
        }
        
        if (this.boundHandleScroll && this.container) {
            this.container.removeEventListener('scroll', this.boundHandleScroll);
        }
        
        if (this.delegationHandler && this.container) {
            this.container.removeEventListener('click', this.delegationHandler);
        }
        
        this.eventListeners.forEach(({ element, event, handler }) => {
            element.removeEventListener(event, handler);
        });
        this.eventListeners.clear();
        
        if (this.container) {
            this.container.innerHTML = '';
        }
        this.domPool = [];
        this.data = [];
        
        this.topSpacer = null;
        this.bottomSpacer = null;
        this.boundHandleScroll = null;
        this.delegationHandler = null;
    }
}

// 【搜索功能增强】高亮搜索关键词
function highlightSearchTerm(text, searchTerm) {
    if (!text || !searchTerm) return text;
    
    // 转义HTML特殊字符
    const escapedText = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const escapedTerm = searchTerm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    
    // 创建正则表达式，不区分大小写
    const regex = new RegExp(`(${escapedTerm})`, 'gi');
    
    // 替换匹配的文本为高亮标记
    return escapedText.replace(regex, '<mark class="bg-yellow-200 dark:bg-yellow-900/50 text-yellow-900 dark:text-yellow-200 font-semibold px-0.5 rounded">$1</mark>');
}

// 渲染数据库列表
function renderDatabase() {
    const data = ListState.data;
    currentFilteredData = data;
    
    document.querySelectorAll('[id^="sort-icon-"]').forEach(el => {
        el.innerText = '↕';
        el.className = 'ml-1 opacity-30 text-[10px]';
    });
    const activeIcon = document.getElementById(`sort-icon-${ListState.sorting.col}`);
    if (activeIcon) {
        activeIcon.innerText = ListState.sorting.asc ? '↑' : '↓';
        activeIcon.className = 'ml-1 opacity-100 text-blue-600';
    }

    const selectAllBox = document.getElementById('selectAll');
    if (selectAllBox) {
        selectAllBox.checked = false;
        selectAllBox.indeterminate = false;
    }

    const container = document.getElementById('dbContent');
    
    if (data.length === 0) {
        container.innerHTML = '';
        document.getElementById('emptyState').classList.remove('hidden');
        
        if (virtualScrollManager) {
            virtualScrollManager.destroy();
            virtualScrollManager = null;
            // 同步到全局
            if (typeof window !== 'undefined') {
                window.virtualScrollManager = null;
            }
        }
    } else {
        document.getElementById('emptyState').classList.add('hidden');
        
        if (!virtualScrollManager) {
            container.style.overflowY = 'auto';
            container.style.height = 'calc(100vh - 400px)';
            
            virtualScrollManager = new VirtualScrollManager('dbContent', 80);
            // 同步到全局
            if (typeof window !== 'undefined') {
                window.virtualScrollManager = virtualScrollManager;
            }
        }
        
        virtualScrollManager.updateData(data, ListState.totalCount);
    }
    
    document.getElementById('count_text').innerText = ListState.totalCount;
    const totalUSD = data.reduce((sum, item) => sum + parseFloat(item.claim_total||0), 0);
    document.getElementById('money_text').innerText = `$${totalUSD.toFixed(2)}`;
    updatePieChart(data);
    
    // 【搜索功能增强】更新搜索结果提示
    if (typeof window.updateSearchResultHint === 'function') {
        window.updateSearchResultHint();
    }
}

// 渲染分页控件
function renderPaginationControls() {
    const paginationContainer = document.getElementById('pagination-container');
    if (!paginationContainer) return;
    
    const totalPages = Math.ceil(ListState.totalCount / ListState.pagination.pageSize);
    const currentPage = ListState.pagination.page;
    
    let paginationHTML = `
        <div class="flex items-center justify-between p-4 border-t border-slate-100">
            <div class="flex items-center space-x-2">
                <span class="text-sm text-slate-600">显示行数：</span>
                <select id="page-size-select" class="text-sm border border-slate-300 rounded-md px-2 py-1 focus:outline-none focus:ring-2 focus:ring-blue-500">
    `;
    
    ListState.pagination.pageSizeOptions.forEach(size => {
        paginationHTML += `<option value="${size}" ${ListState.pagination.pageSize === size ? 'selected' : ''}>${size}</option>`;
    });
    
    paginationHTML += `
                </select>
            </div>
            <div class="flex items-center space-x-2">
                <span class="text-sm text-slate-600">共 ${ListState.totalCount} 条记录，第 ${currentPage} / ${totalPages} 页</span>
                <button id="prev-page" class="px-3 py-1 bg-white border border-slate-300 rounded-md text-sm hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed" ${currentPage === 1 ? 'disabled' : ''}>
                    上一页
                </button>
                <button id="next-page" class="px-3 py-1 bg-white border border-slate-300 rounded-md text-sm hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed" ${currentPage < totalPages ? '' : 'disabled'}>
                    下一页
                </button>
            </div>
        </div>
    `;
    
    paginationContainer.innerHTML = paginationHTML;
    
    document.getElementById('page-size-select').addEventListener('change', (e) => {
        ListState.pagination.pageSize = parseInt(e.target.value);
        ListState.pagination.page = 1;
        localStorage.setItem('wh_claims_pageSize', ListState.pagination.pageSize);
        fetchTableData();
    });
    
    document.getElementById('prev-page').addEventListener('click', () => {
        if (ListState.pagination.page > 1) {
            ListState.pagination.page--;
            fetchTableData();
        }
    });
    
    document.getElementById('next-page').addEventListener('click', () => {
        if (ListState.pagination.page < totalPages) {
            ListState.pagination.page++;
            fetchTableData();
        }
    });
}

// 获取表单数据
function getFormDataFromInput() {
    return {
        id: editingId || generateUUID(),
        cust_name: document.getElementById('cust_name').value,
        contact_name: document.getElementById('contact_name').value,
        contact_info: document.getElementById('contact_info').value,
        order_no: document.getElementById('order_no').value.trim(),
        tracking_no: document.getElementById('tracking_no').value,
        ship_date: document.getElementById('ship_date').value,
        sku: document.getElementById('sku').value,
        warehouse: document.getElementById('warehouse').value,
        claim_type: document.getElementById('claim_type').value,
        description: document.getElementById('description').value,
        currency: document.getElementById('currency').value,
        val_amount: document.getElementById('val_amount').value,
        claim_qty: document.getElementById('claim_qty').value,
        claim_total: document.getElementById('claim_total').value,
        liable_party: document.getElementById('liable_party').value,
        claim_ratio: document.getElementById('claim_ratio').value,
        attachments: document.getElementById('attachments').value,
        remarks: document.getElementById('remarks').value,
        entry_date: document.getElementById('entry_date').value || new Date().toISOString().split('T')[0],
        process_status: document.getElementById('process_status').value
    };
}

// 处理表单提交
async function processEntry() {
    const form = document.getElementById('claimForm');
    if (!form.checkValidity()) {
        return form.reportValidity();
    }
    
    const inputOrderNo = document.getElementById('order_no').value.trim();
    
    const isDuplicate = database.some(item => {
        if (editingId && item.id === editingId) return false;
        return item.order_no === inputOrderNo;
    });
    if (isDuplicate) {
        showToast('错误：该海外仓单号已存在，请勿重复添加！', 'error');
        return;
    }

    const record = getFormDataFromInput();
    
    if (editingId) {
        const index = database.findIndex(i => i.id === editingId);
        if (index !== -1) {
            database[index] = record;
            await updateDataInSupabase(editingId, record);
            localStorage.setItem('wh_claims_db_pro', JSON.stringify(database));
            fetchTableData();
            renderKanban();
            showToast('数据修改已保存', 'success');
            cancelEditMode();
            return;
        }
    } else {
        database.unshift(record);
        await saveDataToSupabase();
        localStorage.setItem('wh_claims_db_pro', JSON.stringify(database));
        fetchTableData();
        renderKanban();
        showToast('提交成功', 'success');
        
        isFormDirty = false;
        editingId = null;
        form.reset();
        
        document.getElementById('cust_name').value = "深圳市信凯源科技有限公司";
        document.getElementById('contact_name').value = "沈学章";
        document.getElementById('contact_info').value = "shenxz1989@foxmail.com";
        const today = new Date();
        const year = today.getFullYear();
        const month = String(today.getMonth() + 1).padStart(2, '0');
        const day = String(today.getDate()).padStart(2, '0');
        document.getElementById('entry_date').value = `${year}-${month}-${day}`;
        document.getElementById('currency').value = 'USD';
        document.getElementById('process_status').value = '待审核';
        
        await switchView('data');
    }
}

// 编辑行
async function editRowById(id) {
    const item = database.find(i => i.id === id);
    if (!item) return;
    
    await trySwitchView('form');
    document.getElementById('liable_party').value = item.liable_party || '待核实';
    document.getElementById('claim_ratio').value = item.claim_ratio || '100';
    document.getElementById('attachments').value = item.attachments || '';
    document.getElementById('remarks').value = item.remarks || '';
    document.getElementById('cust_name').value = item.cust_name || '';
    document.getElementById('contact_name').value = item.contact_name || '';
    document.getElementById('contact_info').value = item.contact_info || '';
    document.getElementById('order_no').value = item.order_no || '';
    document.getElementById('tracking_no').value = item.tracking_no || '';
    document.getElementById('ship_date').value = item.ship_date || '';
    document.getElementById('sku').value = item.sku || '';
    document.getElementById('warehouse').value = item.warehouse || '';
    document.getElementById('claim_type').value = item.claim_type || '货物损坏';
    document.getElementById('description').value = item.description || '';
    document.getElementById('currency').value = item.currency || 'USD';
    document.getElementById('val_amount').value = item.val_amount || '';
    document.getElementById('claim_qty').value = item.claim_qty || '';
    document.getElementById('claim_total').value = item.claim_total || '';
    document.getElementById('process_status').value = item.process_status || '待审核';
    let dateValue = item.entry_date || '';
    if (dateValue && dateValue.length >= 10) {
        dateValue = dateValue.substring(0, 10);
    }
    document.getElementById('entry_date').value = dateValue;
    document.getElementById('process_status').value = item.process_status || '待审核';
    document.getElementById('remarks').value = item.remarks || '';
    editingId = id;
    document.getElementById('submitBtnText').innerText = "确认修改";
    document.getElementById('cancelEditBtn').classList.remove('hidden');
    showToast('已进入编辑模式', 'info');
}

// 取消编辑模式
async function cancelEditMode() {
    editingId = null;
    document.getElementById('claimForm').reset();
    document.getElementById('cust_name').value = "深圳市信凯源科技有限公司";
    document.getElementById('contact_name').value = "沈学章";
    document.getElementById('contact_info').value = "shenxz1989@foxmail.com";
    document.getElementById('submitBtnText').innerText = "确认提交并保存";
    document.getElementById('cancelEditBtn').classList.add('hidden');
    isFormDirty = false;
    await trySwitchView('data');
}

// 删除行
async function deleteRowById(id) {
    if (confirm('确定删除该条记录吗？')) {
        database = database.filter(i => i.id !== id);
        await deleteDataFromSupabase(id);
        localStorage.setItem('wh_claims_db_pro', JSON.stringify(database));
        if (editingId === id) cancelEditMode();
        else {
            renderKanban();
            fetchTableData();
        }
        showToast('记录已删除', 'error');
    }
}

// 下载单行
function downloadRowById(id) {
    const item = database.find(i => i.id === id);
    if (item) {
        exportSingleExcel(item);
        showToast('正在导出...', 'success');
    } else {
        showToast('未找到记录', 'error');
    }
}

// 格式化日期时间显示
function formatDateTimeDisplay(isoString) {
    if (!isoString) return '';
    const date = new Date(isoString);
    if (isNaN(date.getTime())) return isoString;

    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    const h = String(date.getHours()).padStart(2, '0');
    const min = String(date.getMinutes()).padStart(2, '0');
    const s = String(date.getSeconds()).padStart(2, '0');
    
    return `${y}-${m}-${d} ${h}:${min}:${s}`;
}

// 检查Supabase表结构
async function checkSupabaseTableStructure() {
    if (!supabaseClient) return;
    try {
        const { data: tableInfo, error: tableError } = await supabaseClient
            .from('claims_v2')
            .select('*')
            .limit(1);
        
        if (tableError) {
            console.error('获取表信息失败：', tableError);
        } else {
            console.log('表结构检查成功，表中现有数据行数：', tableInfo.length);
        }
    } catch (error) {
        console.error('检查表结构异常：', error);
    }
}

// 初始化应用
document.addEventListener('DOMContentLoaded', () => {
    initTheme();
    if (supabaseClient) {
        initAuth();
    }
    initLoginForms();
    initTitleSync();

    const today = new Date();
    const year = today.getFullYear();
    const month = String(today.getMonth() + 1).padStart(2, '0');
    const day = String(today.getDate()).padStart(2, '0');
    document.getElementById('entry_date').value = `${year}-${month}-${day}`;
    
    updateNavState('form');
    window.onbeforeunload = () => isFormDirty ? "您有未保存的内容" : undefined;
    
    checkSupabaseTableStructure();
    
    // 注意：不要在 DOMContentLoaded 时加载公告，因为此时视图是隐藏的
    // 公告列表应该在切换到公告视图时通过 trySwitchView 函数加载
    // 如果当前视图是公告视图，则加载公告
    const noticeView = document.getElementById('view-notice');
    if (noticeView && !noticeView.classList.contains('hidden')) {
        // 只有当前视图是公告视图时才加载
        if (typeof window.loadNotices === 'function') {
            setTimeout(() => {
                window.loadNotices();
                // 运行公告排序测试
                if (typeof window.testNoticeSorting === 'function') {
                    console.log('\n=== 公告中心排序测试 ===');
                    window.testNoticeSorting();
                }
            }, 200);
        }
    }
    
    const searchInput = document.getElementById('searchInput');
    if (searchInput) {
        const debouncedApplyFilters = debounce(applyFilters, 300);
        searchInput.addEventListener('input', debouncedApplyFilters);
    }
});

