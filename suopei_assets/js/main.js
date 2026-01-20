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
        searchField: 'order_tracking_sku',
        batchSearch: null,       // 批量搜索关键词数组
        advancedSearch: null
    },
    sorting: {
        col: 'entry_date',
        asc: false,
        isUserDefined: false  // 标记是否为用户主动设置的排序
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

// 事件监听器管理器（内存泄漏修复）
const EventListenerManager = {
    listeners: new Map(),
    
    /**
     * 添加事件监听器并记录
     * @param {HTMLElement} element - 目标元素
     * @param {string} event - 事件类型
     * @param {Function} handler - 事件处理函数
     * @param {string} key - 唯一标识符
     */
    add(element, event, handler, key) {
        // 如果已存在相同key的监听器，先移除
        if (this.listeners.has(key)) {
            const old = this.listeners.get(key);
            old.element.removeEventListener(old.event, old.handler);
        }
        
        // 添加新监听器
        element.addEventListener(event, handler);
        
        // 记录监听器
        this.listeners.set(key, { element, event, handler });
    },
    
    /**
     * 移除指定key的监听器
     * @param {string} key - 唯一标识符
     */
    remove(key) {
        if (this.listeners.has(key)) {
            const { element, event, handler } = this.listeners.get(key);
            element.removeEventListener(event, handler);
            this.listeners.delete(key);
        }
    },
    
    /**
     * 清理所有监听器
     */
    clear() {
        this.listeners.forEach(({ element, event, handler }) => {
            element.removeEventListener(event, handler);
        });
        this.listeners.clear();
    },
    
    /**
     * 清理指定前缀的所有监听器（用于清理分页控件）
     * @param {string} prefix - 前缀
     */
    clearByPrefix(prefix) {
        const keysToRemove = [];
        this.listeners.forEach((value, key) => {
            if (key.startsWith(prefix)) {
                keysToRemove.push(key);
            }
        });
        keysToRemove.forEach(key => this.remove(key));
    }
};

// 生成UUID
function generateUUID() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
        const r = Math.random() * 16 | 0;
        const v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}

/**
 * 重置排序为默认值（申请提交日期降序）
 * 标记为系统默认排序，不持久化
 * 清除与当前筛选条件相关的缓存，确保排序状态变化时缓存失效
 */
function resetSortingToDefault() {
    ListState.sorting.col = 'entry_date';
    ListState.sorting.asc = false;
    ListState.sorting.isUserDefined = false;
    
    // 清除与当前筛选条件相关的所有缓存（忽略排序），避免使用错误的排序缓存
    if (typeof window.clearCacheByFilters === 'function') {
        window.clearCacheByFilters(ListState.filters);
    } else if (typeof clearCacheByFilters === 'function') {
        clearCacheByFilters(ListState.filters);
    }
}

// 虚拟滚动管理器类（性能优化版）
class VirtualScrollManager {
    constructor(containerId, itemHeight) {
        // 从配置中获取行高，如果没有传入则使用配置值
        if (!itemHeight) {
            itemHeight = (typeof TABLE_ROW_HEIGHT !== 'undefined') ? TABLE_ROW_HEIGHT : 130;
        }
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
        
        this.scrollThrottleTimer = null;
        this.renderAnimationFrame = null;
        this.lastRenderTime = 0;
        this.renderInterval = 16;
        this.lastScrollTop = 0;
        this.lastScrollTime = Date.now();
        this.scrollVelocity = 0; // 滚动速度（px/ms）
        this.loadMoreRetryCount = 0; // 加载失败重试次数
        this.loadMoreRetryDelay = 1000; // 初始重试延迟（ms）
        this.maxRetryDelay = 30000; // 最大重试延迟（ms）
        this.baseTriggerDistance = 200; // 基础触发距离（px）
        this.loadingIndicator = null; // 加载指示器元素

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
        this.boundHandleScroll = (e) => {
            const now = Date.now();
            const currentScrollTop = e.target.scrollTop;
            
            const timeDelta = now - this.lastScrollTime;
            if (timeDelta > 0) {
                const scrollDelta = Math.abs(currentScrollTop - this.lastScrollTop);
                this.scrollVelocity = scrollDelta / timeDelta; // px/ms
            }
            this.lastScrollTop = currentScrollTop;
            this.lastScrollTime = now;
            this.scrollTop = currentScrollTop;
            
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
        if (!this.container || !this.container.parentElement) {
            return;
        }
        
        let newStartIndex = Math.floor(this.scrollTop / this.itemHeight) - this.bufferCount;
        newStartIndex = Math.max(0, newStartIndex);

        const visibleHeight = this.container.clientHeight;
        this.visibleCount = Math.ceil(visibleHeight / this.itemHeight);

        // 服务端分页模式下，this.data 只包含当前页数据，必须用实际长度而非 totalItems 计算渲染范围
        const actualDataLength = this.data ? this.data.length : 0;
        let newEndIndex = newStartIndex + this.visibleCount + (this.bufferCount * 2);
        newEndIndex = Math.min(actualDataLength, newEndIndex);

        if (newStartIndex !== this.startIndex || newEndIndex !== this.endIndex) {
            const oldStartIndex = this.startIndex;
            const oldEndIndex = this.endIndex;
            
            this.startIndex = newStartIndex;
            this.endIndex = newEndIndex;
            
            if (oldStartIndex !== -1 && 
                Math.abs(newStartIndex - oldStartIndex) < this.visibleCount * 2 &&
                Math.abs(newEndIndex - oldEndIndex) < this.visibleCount * 2) {
                this.renderVisibleItemsIncremental(oldStartIndex, oldEndIndex);
            } else {
                this.renderVisibleItems();
            }
        }
        
        // 强制应用行高样式，确保所有行高度一致
        this.applyUniformRowHeight();
    }
    
    /**
     * 强制应用统一行高，确保所有行高度一致
     */
    applyUniformRowHeight() {
        if (!this.container) return;
        
        const rowHeightPx = `${this.itemHeight}px`;
        const rows = this.container.querySelectorAll('tr[data-item-id]');
        rows.forEach(row => {
            row.style.height = rowHeightPx;
            row.style.minHeight = rowHeightPx;
            row.style.maxHeight = rowHeightPx;
            
            // 同时设置所有单元格的高度和垂直对齐
            const cells = row.querySelectorAll('td');
            cells.forEach(cell => {
                cell.style.height = rowHeightPx;
                cell.style.verticalAlign = 'middle';
            });
        });
    }
    
    renderVisibleItems() {
        const visibleData = this.data.slice(this.startIndex, this.endIndex);
        
        const actualDataLength = this.data ? this.data.length : 0;
        const topHeight = this.startIndex * this.itemHeight;
        const bottomHeight = (actualDataLength - this.endIndex) * this.itemHeight;

        this.topSpacer.style.height = `${topHeight}px`;
        this.bottomSpacer.style.height = `${bottomHeight}px`;
        
        const actualColspan = visibleColumns.length + 2;
        this.topSpacer.innerHTML = `<td colspan="${actualColspan}" style="padding:0; border:none;"></td>`;
        this.bottomSpacer.innerHTML = `<td colspan="${actualColspan}" style="padding:0; border:none;"></td>`;

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

        const fragment = document.createDocumentFragment();
        
        visibleData.forEach((item, index) => {
            const actualIndex = this.startIndex + index;
            const tr = this.createOrReuseRow(item, actualIndex);
            fragment.appendChild(tr);
        });

        if (!this.container || !this.bottomSpacer || !this.container.contains(this.bottomSpacer)) {
            return;
        }
        
        this.container.insertBefore(fragment, this.bottomSpacer);
    }
    
    /**
     * 增量渲染：仅更新变化的行，避免全量重渲染
     * @param {number} oldStartIndex - 旧的起始索引
     * @param {number} oldEndIndex - 旧的结束索引
     */
    renderVisibleItemsIncremental(oldStartIndex, oldEndIndex) {
        const actualDataLength = this.data ? this.data.length : 0;
        const topHeight = this.startIndex * this.itemHeight;
        const bottomHeight = (actualDataLength - this.endIndex) * this.itemHeight;

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
            if (!this.container || !this.bottomSpacer || !this.container.contains(this.bottomSpacer)) {
                return;
            }
            
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
        
        // 从配置中获取行高值
        const rowHeight = (typeof TABLE_ROW_HEIGHT !== 'undefined') ? TABLE_ROW_HEIGHT : 130;
        const rowHeightPx = `${rowHeight}px`;
        
        tr.className = 'group hover:bg-blue-50/40 transition-colors border-b border-slate-50 last:border-0';
        tr.style.height = rowHeightPx;
        tr.style.minHeight = rowHeightPx;
        tr.style.maxHeight = rowHeightPx;
        tr.dataset.itemId = item.id;
        tr.dataset.index = index;
        this.renderRowContent(tr, item);
        return tr;
    }
    
    renderRowContent(tr, item) {
        const rowHeight = (typeof TABLE_ROW_HEIGHT !== 'undefined') ? TABLE_ROW_HEIGHT : 130;
        const rowHeightPx = `${rowHeight}px`;
        
        const symbol = item.currency === 'CNY' ? '¥' : (item.currency === 'EUR' ? '€' : (item.currency === 'GBP' ? '£' : '$'));
        const colConfigs = {};
        TABLE_COLUMNS.forEach(col => colConfigs[col.key] = col);
        const cells = [];
        
        const searchTerm = ListState.filters.search || '';
        const shouldHighlight = searchTerm.trim() && ListState.filters.searchMode !== 'exact';
        const checkboxTd = document.createElement('td');
        checkboxTd.className = 'erp-td text-center col--checkbox is--fixed-left';
        checkboxTd.style.width = '48px';
        checkboxTd.style.minWidth = '48px';
        checkboxTd.style.height = rowHeightPx;
        checkboxTd.onclick = (e) => e.stopPropagation();
        const checkboxCell = document.createElement('div');
        checkboxCell.className = 'vxe-cell';
        checkboxCell.style.maxHeight = rowHeightPx;
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.className = 'row-checkbox w-4 h-4 text-emerald-600 rounded border-slate-300 focus:ring-emerald-500 cursor-pointer bg-slate-50 dark:bg-slate-700 dark:border-slate-600';
        checkbox.value = item.id;
        checkbox.onclick = updateSelectAllState;
        checkboxCell.appendChild(checkbox);
        checkboxTd.appendChild(checkboxCell);
        cells.push(checkboxTd);
        
        visibleColumns.forEach(key => {
            const td = document.createElement('td');
            const col = colConfigs[key];
            td.className = 'erp-td';
            td.style.minWidth = col.minW;
            let content = item[key] || '';
            let style = '';
            let plainText = '';
            
            if (key === 'entry_date' || key === 'ship_date') {
                content = (typeof formatDateDisplay !== 'undefined') ? formatDateDisplay(content) : formatDateTimeDisplay(content).split(' ')[0];
                plainText = content;
            } else if (key === 'created_at') {
                content = formatDateTimeDisplay(content);
                plainText = content;
            } else if (key === 'store_by') {
                plainText = String(content || '');
                if (content && content.trim()) {
                    content = `<span class="inline-flex items-center px-2.5 py-0.5 rounded-lg text-xs font-semibold bg-gradient-to-r from-emerald-50 to-teal-50 dark:from-emerald-900/30 dark:to-teal-900/30 text-emerald-700 dark:text-emerald-200 border border-emerald-200/60 dark:border-emerald-700/40 shadow-sm hover:shadow transition-shadow">${content}</span>`;
                } else {
                    content = '<span class="text-slate-400 dark:text-slate-500 text-xs">-</span>';
                }
            } else if (key === 'order_no') {
                style = 'font-bold text-blue-600';
                plainText = String(content || '');
            } else if (key === 'process_status') {
                content = getStatusBadge(content);
                plainText = String(item[key] || '');
            } else if (key === 'val_amount' || key === 'claim_total') {
                if (hasPermission('can_view_money')) {
                    const amount = parseFloat(content).toFixed(2);
                    content = `<span class="font-mono">${symbol}${amount}</span>`;
                    plainText = `${symbol}${amount}`;
                    if (key === 'claim_total') style = 'font-bold text-red-600';
                } else {
                    content = `<span class="font-mono text-slate-400">***.${symbol}</span>`;
                    plainText = `***.${symbol}`;
                    style = 'font-bold text-slate-400';
                }
            } else if (key === 'description') {
                plainText = String(content || '');
                content = `<div class="twoLines" style="max-width: 200px;">${content}</div>`;
            } else {
                plainText = String(content || '');
                if (content && typeof content === 'string' && content.length > 0) {
                    content = `<div class="oneLine">${content}</div>`;
                }
            }
            
            if (shouldHighlight && content && typeof content === 'string' && !content.includes('<')) {
                content = highlightSearchTerm(content, searchTerm);
            }
            
            if (col.center) style += ' text-center';
            if (style) td.className += ` ${style}`;
            td.style.minWidth = col.minW;
            td.style.width = col.minW;
            td.style.height = rowHeightPx;
            
            if (plainText && plainText.trim()) {
                td.title = plainText;
            }
            
            const cellWrapper = document.createElement('div');
            cellWrapper.className = 'vxe-cell';
            cellWrapper.style.maxHeight = rowHeightPx;
            
            if (key === 'description') {
                cellWrapper.className += ' twoLines';
            } else if (plainText && plainText.length > 0 && typeof plainText === 'string') {
                cellWrapper.className += ' oneLine col--ellipsis';
            }
            
            cellWrapper.innerHTML = content;
            td.appendChild(cellWrapper);
            cells.push(td);
        });
        const actionTd = document.createElement('td');
        actionTd.className = 'erp-td pr-6 text-center is--fixed-right';
        actionTd.style.width = '120px';
        actionTd.style.minWidth = '120px';
        actionTd.style.height = rowHeightPx;
        actionTd.onclick = (e) => e.stopPropagation();
        const actionCell = document.createElement('div');
        actionCell.className = 'vxe-cell';
        actionCell.style.maxHeight = rowHeightPx;
        const actionDiv = document.createElement('div');
        actionDiv.className = 'flex items-center justify-center space-x-1';
        
        if (hasPermission('can_edit')) actionDiv.appendChild(this.createActionButton('edit', item.id, '编辑'));
        if (hasPermission('can_edit')) actionDiv.appendChild(this.createActionButton('status', item.id, '更新状态'));
        if (hasPermission('can_export')) actionDiv.appendChild(this.createActionButton('download', item.id, '导出'));
        if (hasPermission('can_delete')) actionDiv.appendChild(this.createActionButton('delete', item.id, '删除'));
        
        actionCell.appendChild(actionDiv);
        actionTd.appendChild(actionCell);
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
                btn.onclick = () => openEditModal(itemId);
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
    
    // 【性能优化】检测数据是否变化
    // 【修复】不仅检查ID序列，还要检查关键字段（如process_status）是否变化
    hasDataChanged(oldData, newData) {
        if (!oldData || !newData) return true;
        if (oldData.length !== newData.length) return true;
        
        // 检查每个项的ID和关键字段是否变化
        return oldData.some((item, index) => {
            const newItem = newData[index];
            if (!newItem) return true;
            if (item.id !== newItem.id) return true;
            // 【修复】检查关键字段是否变化（特别是process_status）
            if (item.process_status !== newItem.process_status) return true;
            // 检查其他可能变化的字段
            if (item.claim_total !== newItem.claim_total) return true;
            return false;
        });
    }
    
    // 【性能优化】计算数据变化范围（返回变化的索引范围和比例）
    calculateChangedRange(oldData, newData) {
        if (!oldData || !newData || oldData.length === 0) {
            return { start: 0, end: newData.length, count: newData.length, ratio: 1.0 };
        }
        
        // 创建ID到索引的映射
        const oldIdMap = new Map(oldData.map((item, index) => [item.id, index]));
        const newIdMap = new Map(newData.map((item, index) => [item.id, index]));
        
        // 找出变化的位置（新增、删除、移动的项）
        const changedIndices = new Set();
        
        newData.forEach((item, newIndex) => {
            const oldIndex = oldIdMap.get(item.id);
            // 如果项不存在于旧数据中，或者位置发生了变化
            if (oldIndex === undefined || oldIndex !== newIndex) {
                changedIndices.add(newIndex);
            }
        });
        
        oldData.forEach((item, oldIndex) => {
            const newIndex = newIdMap.get(item.id);
            // 如果项在新数据中不存在，标记旧位置所在的范围
            if (newIndex === undefined) {
                // 标记受影响的范围（简化处理：标记旧位置）
                changedIndices.add(Math.min(oldIndex, newData.length - 1));
            }
        });
        
        const changedCount = changedIndices.size;
        const totalCount = newData.length;
        const ratio = totalCount > 0 ? changedCount / totalCount : 1.0;
        
        // 计算变化范围（最小和最大索引）
        const indices = Array.from(changedIndices);
        const start = indices.length > 0 ? Math.min(...indices) : 0;
        const end = indices.length > 0 ? Math.max(...indices) + 1 : totalCount;
        
        return { start, end, count: changedCount, ratio };
    }
    
    // 【性能优化】更新变化的项（智能增量更新）
    updateChangedItems(changedRange) {
        // 更新可见范围内变化的数据
        this.scrollTop = this.container.scrollTop;
        
        // 计算当前的可见范围
        let newStartIndex = Math.floor(this.scrollTop / this.itemHeight) - this.bufferCount;
        newStartIndex = Math.max(0, newStartIndex);
        
        const visibleHeight = this.container.clientHeight;
        this.visibleCount = Math.ceil(visibleHeight / this.itemHeight);
        
        // 使用实际数据长度计算渲染范围，避免超出当前页数据
        const actualDataLength = this.data ? this.data.length : 0;
        let newEndIndex = newStartIndex + this.visibleCount + (this.bufferCount * 2);
        newEndIndex = Math.min(actualDataLength, newEndIndex);
        const overlapStart = Math.max(changedRange.start, newStartIndex);
        const overlapEnd = Math.min(changedRange.end, newEndIndex);
        
        const oldStartIndex = this.startIndex;
        const oldEndIndex = this.endIndex;
        this.startIndex = newStartIndex;
        this.endIndex = newEndIndex;
        
        if (overlapStart < overlapEnd) {
            // 有重叠，需要更新可见范围内的变化项
            // 使用增量更新方式
            if (oldStartIndex !== -1 && 
                Math.abs(newStartIndex - oldStartIndex) < this.visibleCount * 2 &&
                Math.abs(newEndIndex - oldEndIndex) < this.visibleCount * 2) {
                // 使用增量渲染
                this.renderVisibleItemsIncremental(oldStartIndex, oldEndIndex);
            } else {
                // 范围变化较大，使用全量渲染
                this.renderVisibleItems();
            }
        } else {
            // 变化范围不在可见区域，仅更新 spacer 高度，避免不必要的 DOM 操作
            const actualDataLength = this.data ? this.data.length : 0;
            const topHeight = this.startIndex * this.itemHeight;
            const bottomHeight = (actualDataLength - this.endIndex) * this.itemHeight;
            if (this.topSpacer) {
                this.topSpacer.style.height = `${topHeight}px`;
            }
            if (this.bottomSpacer) {
                this.bottomSpacer.style.height = `${bottomHeight}px`;
            }
        }
    }
    
    // 【性能优化】智能数据更新（支持增量更新）
    // 【防闪烁优化】保存滚动位置，使用 requestAnimationFrame 确保平滑渲染
    // 【修复】增加 forceRefresh 参数，强制刷新时立即渲染
    updateData(newData, totalItems, forceRefresh = false) {
        if (!this.container || !this.container.parentElement) {
            return;
        }
        
        // 保存当前滚动位置
        const savedScrollTop = this.container.scrollTop;
        const oldData = this.data;
        const dataChanged = this.hasDataChanged(oldData, newData);
        
        // 【关键修复】验证传入的数据是否符合当前状态筛选条件
        // 【删除】删除了此处用于过滤 ListState.filters.status 的逻辑
        // 直接使用 newData，因为数据已经在 database.js 中正确筛选
        
        this.data = newData;
        this.totalItems = totalItems;
        this.scrollTop = savedScrollTop;
        
        if (!dataChanged && !forceRefresh) {
            // 数据未变化且非强制刷新，只更新totalItems（可能影响分页）
            // 不需要重新渲染
            return;
        }
        
        // 【修复】强制刷新时立即渲染，非强制刷新时使用 requestAnimationFrame
        if (forceRefresh) {
            // 强制刷新时立即渲染，确保数据立即显示
            this.updateRenderRange();
            this.renderVisibleItems();
            // 恢复滚动位置
            if (savedScrollTop > 0) {
                this.container.scrollTop = savedScrollTop;
            }
            // 强制应用统一行高
            requestAnimationFrame(() => {
                this.applyUniformRowHeight();
            });
        } else {
            // 使用 requestAnimationFrame 包装数据更新逻辑，确保平滑渲染
            if (this.renderAnimationFrame) {
                cancelAnimationFrame(this.renderAnimationFrame);
            }
            
            this.renderAnimationFrame = requestAnimationFrame(() => {
                // 数据已变化，计算变化范围
                const changedRange = this.calculateChangedRange(oldData, newData);
                
                // 如果变化范围小于30%，尝试使用增量更新
                if (changedRange.ratio < 0.3 && oldData && oldData.length > 0) {
                    this.updateChangedItems(changedRange);
                    // 恢复滚动位置
                    this.container.scrollTop = savedScrollTop;
                    // 强制应用统一行高
                    requestAnimationFrame(() => {
                        this.applyUniformRowHeight();
                    });
                } else {
                    // 变化较大，使用全量更新
                    // 基于滚动位置计算 startIndex
                    const calculatedStartIndex = Math.floor(savedScrollTop / this.itemHeight);
                    this.startIndex = calculatedStartIndex >= 0 ? calculatedStartIndex : -1;
                    
                    this.updateRenderRange();
                    
                    // 渲染后恢复滚动位置
                    requestAnimationFrame(() => {
                        this.container.scrollTop = savedScrollTop;
                        // 强制应用统一行高
                        this.applyUniformRowHeight();
                    });
                }
                
                this.renderAnimationFrame = null;
            });
        }
    }
    
    /**
     * 【增量数据加载优化】检查是否需要加载更多数据
     * 使用动态触发距离，根据屏幕高度和滚动速度智能调整
     */
    checkLoadMore() {
        if (this.data.length >= this.totalItems || this.isLoading) return;
        
        const scrollBottom = this.scrollTop + this.container.clientHeight;
        const totalHeight = this.totalItems * this.itemHeight;
        const distanceToBottom = totalHeight - scrollBottom;
        
        // 【动态触发距离】根据屏幕高度和滚动速度智能调整触发距离
        const screenHeight = this.container.clientHeight;
        const baseDistance = this.baseTriggerDistance;
        
        // 根据屏幕高度调整（大屏幕使用更大的触发距离）
        const screenBasedDistance = Math.max(baseDistance, screenHeight * 0.3);
        
        // 根据滚动速度调整（快速滚动时提前触发，慢速滚动时延迟触发）
        // 滚动速度越快，触发距离越大（预加载）
        const velocityMultiplier = 1 + Math.min(this.scrollVelocity * 10, 2); // 最大2倍
        const dynamicTriggerDistance = screenBasedDistance * velocityMultiplier;
        
        if (distanceToBottom < dynamicTriggerDistance) {
            this.loadMoreData();
        }
    }
    
    /**
     * 【增量数据加载优化】加载更多数据
     * 包含加载状态管理、错误提示和指数退避重试机制
     */
    async loadMoreData() {
        if (this.isLoading) return;
        
        this.isLoading = true;
        this.showLoadingIndicator();
        
        try {
            ListState.pagination.page += 1;
            await fetchTableData(true);
            this.updateData(ListState.data, ListState.totalCount);
            
            // 加载成功，重置重试计数
            this.loadMoreRetryCount = 0;
            this.loadMoreRetryDelay = 1000;
            
        } catch (error) {
            // 【指数退避重试机制】网络不稳定时自动重试
            const shouldRetry = this.loadMoreRetryCount < 5; // 最多重试5次
            
            if (shouldRetry) {
                this.loadMoreRetryCount++;
                
                // 指数退避：延迟时间 = base * 2^(retryCount-1)
                const retryDelay = Math.min(
                    this.loadMoreRetryDelay * Math.pow(2, this.loadMoreRetryCount - 1),
                    this.maxRetryDelay
                );
                
                setTimeout(() => {
                    this.isLoading = false; // 重置状态以允许重试
                    this.loadMoreData();
                }, retryDelay);
                
            } else {
                // 重试次数过多，显示错误提示
                this.showLoadError('加载失败，请稍后重试');
                this.loadMoreRetryCount = 0;
                this.loadMoreRetryDelay = 1000;
            }
            
        } finally {
            // 只有在非重试情况下才隐藏加载指示器
            if (this.loadMoreRetryCount === 0 || this.loadMoreRetryCount >= 5) {
                this.hideLoadingIndicator();
                this.isLoading = false;
            }
        }
    }
    
    /**
     * 【增量数据加载优化】显示加载指示器
     */
    showLoadingIndicator() {
        if (this.loadingIndicator) {
            this.loadingIndicator.style.display = 'flex';
            return;
        }
        
        // 创建加载指示器
        const indicator = document.createElement('div');
        indicator.className = 'load-more-indicator';
        indicator.style.cssText = `
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 12px;
            color: #64748b;
            font-size: 14px;
            gap: 8px;
        `;
        indicator.innerHTML = `
            <svg class="animate-spin h-5 w-5" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
            </svg>
            <span>加载中...</span>
        `;
        
        // 插入到容器底部
        if (this.container && this.container.parentElement) {
            this.container.parentElement.appendChild(indicator);
            this.loadingIndicator = indicator;
        }
    }
    
    /**
     * 【增量数据加载优化】隐藏加载指示器
     */
    hideLoadingIndicator() {
        if (this.loadingIndicator) {
            this.loadingIndicator.style.display = 'none';
        }
    }
    
    /**
     * 【增量数据加载优化】显示加载错误提示
     */
    showLoadError(message) {
        if (this.loadingIndicator) {
            this.loadingIndicator.innerHTML = `
                <span style="color: #ef4444;">${message}</span>
            `;
            setTimeout(() => {
                this.hideLoadingIndicator();
            }, 3000);
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
        
        // 【增量数据加载优化】清理加载指示器
        if (this.loadingIndicator && this.loadingIndicator.parentElement) {
            this.loadingIndicator.parentElement.removeChild(this.loadingIndicator);
            this.loadingIndicator = null;
        }
        
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

// 【性能优化】高亮结果缓存（LRU策略）
const highlightCache = new Map();
const MAX_HIGHLIGHT_CACHE_SIZE = 1000;

// 【搜索功能增强】高亮搜索关键词（性能优化版 - 带缓存）
function highlightSearchTerm(text, searchTerm) {
    if (!text || !searchTerm) return text;
    
    // 【性能优化】使用缓存避免重复计算
    const cacheKey = `${text}_${searchTerm}`;
    if (highlightCache.has(cacheKey)) {
        return highlightCache.get(cacheKey);
    }
    
    // 转义HTML特殊字符
    const escapedText = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const escapedTerm = searchTerm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    
    // 创建正则表达式，不区分大小写
    const regex = new RegExp(`(${escapedTerm})`, 'gi');
    
    // 替换匹配的文本为高亮标记
    const highlighted = escapedText.replace(regex, '<mark class="bg-yellow-200 dark:bg-yellow-900/50 text-yellow-900 dark:text-yellow-200 font-semibold px-0.5 rounded">$1</mark>');
    
    // 【性能优化】缓存管理（LRU策略 - 当缓存超过最大大小时，删除最旧的项）
    if (highlightCache.size >= MAX_HIGHLIGHT_CACHE_SIZE) {
        const firstKey = highlightCache.keys().next().value;
        highlightCache.delete(firstKey);
    }
    highlightCache.set(cacheKey, highlighted);
    
    return highlighted;
}

// 【性能优化】统计结果缓存
let cachedStats = null;
let cachedDataHash = null;

// 【性能优化】计算统计数据（带缓存）
// ============================================
// 【骨架屏功能】骨架屏加载器
// ============================================

/**
 * 获取随机宽度（用于模拟内容长度变化）
 * @param {number} min - 最小宽度百分比
 * @param {number} max - 最大宽度百分比
 * @returns {number} 随机宽度百分比
 */
function getRandomWidth(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * 生成表格骨架屏HTML
 * @param {number} rowCount - 骨架行数
 * @param {Array} visibleColumns - 可见列配置
 * @param {number} rowHeight - 行高（px）
 * @returns {string} 骨架屏HTML
 */
function generateSkeletonRows(rowCount, visibleColumns, rowHeight) {
    const rows = [];
    const rowHeightPx = `${rowHeight}px`;
    
    for (let i = 0; i < rowCount; i++) {
        const cells = [];
        
        // 1. 复选框占位
        cells.push(`
            <td class="erp-td text-center col--checkbox" style="width: 48px; height: ${rowHeightPx};">
                <div class="vxe-cell flex items-center justify-center">
                    <div class="skeleton-checkbox w-4 h-4 bg-slate-200 dark:bg-slate-700 border border-slate-300 dark:border-slate-600 rounded"></div>
                </div>
            </td>
        `);
        
        // 2. 动态列占位
        visibleColumns.forEach(colKey => {
            const col = TABLE_COLUMNS.find(c => c.key === colKey);
            if (!col) return;
            
            const widthPercent = getRandomWidth(60, 90); // 随机宽度，模拟内容变化
            
            cells.push(`
                <td class="erp-td" style="min-width: ${col.minW}; width: ${col.minW}; height: ${rowHeightPx};">
                    <div class="vxe-cell flex items-center">
                        <div class="skeleton-bar skeleton-shimmer rounded" 
                             style="width: ${widthPercent}%; height: ${Math.round(rowHeight * 0.6)}px;"></div>
                    </div>
                </td>
            `);
        });
        
        // 3. 操作列占位
        cells.push(`
            <td class="erp-td text-center is--fixed-right" style="width: 120px; height: ${rowHeightPx};">
                <div class="vxe-cell flex items-center justify-center gap-2">
                    <div class="skeleton-dot w-2 h-2 bg-slate-300 dark:bg-slate-600 rounded-full"></div>
                    <div class="skeleton-dot w-2 h-2 bg-slate-300 dark:bg-slate-600 rounded-full"></div>
                    <div class="skeleton-dot w-2 h-2 bg-slate-300 dark:bg-slate-600 rounded-full"></div>
                </div>
            </td>
        `);
        
        rows.push(`<tr>${cells.join('')}</tr>`);
    }
    
    return rows.join('');
}

/**
 * 显示骨架屏
 * @param {number} rowCount - 显示的行数（可选，默认根据容器高度计算）
 */
function showSkeletonTable(rowCount = null) {
    const container = document.getElementById('dbContent');
    if (!container) return;
    
    // 【修复】在显示骨架屏之前，先销毁 VirtualScrollManager，避免DOM引用失效
    // 因为骨架屏会直接替换 container.innerHTML，这会销毁 VirtualScrollManager 创建的 topSpacer 和 bottomSpacer
    if (virtualScrollManager) {
        virtualScrollManager.destroy();
        virtualScrollManager = null;
        window.virtualScrollManager = null;
    }
    
    // 隐藏空状态
    const emptyState = document.getElementById('emptyState');
    if (emptyState) emptyState.classList.add('hidden');
    
    // 计算需要显示的行数
    if (!rowCount) {
        const containerHeight = container.clientHeight || window.innerHeight - 400;
        const rowHeight = (typeof TABLE_ROW_HEIGHT !== 'undefined') ? TABLE_ROW_HEIGHT : 130;
        rowCount = Math.max(3, Math.ceil(containerHeight / rowHeight) + 2); // 至少3行，多显示2行作为缓冲
    }
    
    // 获取可见列配置
    const visibleCols = (typeof window !== 'undefined' && window.visibleColumns) 
        ? window.visibleColumns 
        : TABLE_COLUMNS.map(c => c.key).filter(k => k !== 'remarks');
    
    // 生成并渲染骨架屏
    const rowHeight = (typeof TABLE_ROW_HEIGHT !== 'undefined') ? TABLE_ROW_HEIGHT : 130;
    const skeletonHTML = generateSkeletonRows(rowCount, visibleCols, rowHeight);
    container.innerHTML = skeletonHTML;
    
    // 添加骨架屏标识类
    container.classList.add('skeleton-mode');
}

/**
 * 隐藏骨架屏（清除骨架屏内容）
 */
function hideSkeletonTable() {
    const container = document.getElementById('dbContent');
    if (!container) return;
    
    // 移除骨架屏标识类
    container.classList.remove('skeleton-mode');
    
    // 内容将由 renderDatabase() 填充，这里不需要清空
}

/**
 * 生成用户列表骨架屏HTML
 * @param {number} rowCount - 骨架行数（默认5行）
 * @returns {string} 骨架屏HTML
 */
function generateUserListSkeletonRows(rowCount = 5) {
    const rows = [];
    
    for (let i = 0; i < rowCount; i++) {
        const usernameWidth = getRandomWidth(60, 85);
        const emailWidth = getRandomWidth(70, 95);
        const dateWidth = getRandomWidth(50, 70);
        
        rows.push(`
            <tr>
                <td class="px-6 py-4 whitespace-nowrap">
                    <div class="skeleton-bar skeleton-shimmer rounded" style="width: ${usernameWidth}%; height: 16px;"></div>
                </td>
                <td class="px-6 py-4 whitespace-nowrap">
                    <div class="skeleton-bar skeleton-shimmer rounded" style="width: ${emailWidth}%; height: 16px;"></div>
                </td>
                <td class="px-6 py-4 whitespace-nowrap">
                    <div class="skeleton-bar skeleton-shimmer rounded-full" style="width: 80px; height: 24px;"></div>
                </td>
                <td class="px-6 py-4 whitespace-nowrap">
                    <div class="skeleton-bar skeleton-shimmer rounded-full" style="width: 60px; height: 24px;"></div>
                </td>
                <td class="px-6 py-4 whitespace-nowrap">
                    <div class="skeleton-bar skeleton-shimmer rounded" style="width: ${dateWidth}%; height: 16px;"></div>
                </td>
                <td class="px-6 py-4 whitespace-nowrap text-right">
                    <div class="flex justify-end gap-4">
                        <div class="skeleton-bar skeleton-shimmer rounded" style="width: 40px; height: 16px;"></div>
                        <div class="skeleton-bar skeleton-shimmer rounded" style="width: 40px; height: 16px;"></div>
                    </div>
                </td>
            </tr>
        `);
    }
    
    return rows.join('');
}

/**
 * 显示用户列表骨架屏
 * @param {number} rowCount - 显示的行数（可选，默认5行）
 */
function showSkeletonTableUsers(rowCount = 5) {
    const tbody = document.getElementById('usersTableBody');
    if (!tbody) return;
    
    // 生成并渲染骨架屏
    const skeletonHTML = generateUserListSkeletonRows(rowCount);
    tbody.innerHTML = skeletonHTML;
    
    // 添加骨架屏标识类
    tbody.classList.add('skeleton-mode');
}

/**
 * 隐藏用户列表骨架屏
 */
function hideSkeletonTableUsers() {
    const tbody = document.getElementById('usersTableBody');
    if (!tbody) return;
    
    // 移除骨架屏标识类
    tbody.classList.remove('skeleton-mode');
    
    // 内容将由 renderUserManagement() 填充，这里不需要清空
}

function calculateStats(data) {
    // 计算数据哈希（只基于ID和金额，用于检测数据变化）
    const dataHash = data.map(d => `${d.id}:${d.claim_total || 0}`).join(',');
    
    // 如果数据未变化，返回缓存
    if (dataHash === cachedDataHash && cachedStats) {
        return cachedStats;
    }
    
    // 重新计算统计数据
    const stats = {
        total: data.length,
        totalAmount: data.reduce((sum, item) => 
            sum + parseFloat(item.claim_total || 0), 0)
    };
    
    // 更新缓存
    cachedStats = stats;
    cachedDataHash = dataHash;
    
    return stats;
}

/**
 * 渲染数据列表
 * @param {boolean} resetScroll - 是否强制重置滚动条和虚拟DOM
 */
function renderDatabase(resetScroll = false) {
    const dataView = document.getElementById('view-data');
    if (!dataView || dataView.classList.contains('hidden')) {
        return;
    }
    
    if (typeof hideSkeletonTable === 'function') {
        hideSkeletonTable();
    }
    
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
            window.virtualScrollManager = null;
        }
    } else {
        document.getElementById('emptyState').classList.add('hidden');
        
        if (resetScroll || !virtualScrollManager) {
            if (virtualScrollManager) virtualScrollManager.destroy();
            
            container.innerHTML = '';
            container.style.overflowY = 'auto';
            
            // 动态计算容器高度：根据数据量和行高自动调整
            const rowHeight = (typeof TABLE_ROW_HEIGHT !== 'undefined') ? TABLE_ROW_HEIGHT : 130;
            const maxHeight = window.innerHeight - 400; // 最大高度限制
            const dynamicHeight = Math.min(data.length * rowHeight + 20, maxHeight); // +20为缓冲
            container.style.height = `${dynamicHeight}px`;
            container.style.maxHeight = `${maxHeight}px`;
            
            virtualScrollManager = new VirtualScrollManager('dbContent', rowHeight);
            window.virtualScrollManager = virtualScrollManager;
        }
        
        if (!virtualScrollManager || !virtualScrollManager.container || !virtualScrollManager.container.parentElement) {
            if (virtualScrollManager) {
                virtualScrollManager.destroy();
            }
            container.innerHTML = '';
            container.style.overflowY = 'auto';
            
            // 动态计算容器高度：根据数据量和行高自动调整
            const rowHeight = (typeof TABLE_ROW_HEIGHT !== 'undefined') ? TABLE_ROW_HEIGHT : 130;
            const maxHeight = window.innerHeight - 400; // 最大高度限制
            const dynamicHeight = Math.min(data.length * rowHeight + 20, maxHeight); // +20为缓冲
            container.style.height = `${dynamicHeight}px`;
            container.style.maxHeight = `${maxHeight}px`;
            
            virtualScrollManager = new VirtualScrollManager('dbContent', rowHeight);
            window.virtualScrollManager = virtualScrollManager;
        }
        
        // 更新容器高度，确保数据量变化时高度也能动态调整
        const rowHeight = (typeof TABLE_ROW_HEIGHT !== 'undefined') ? TABLE_ROW_HEIGHT : 130;
        const maxHeight = window.innerHeight - 400; // 最大高度限制
        const dynamicHeight = Math.min(data.length * rowHeight + 20, maxHeight); // +20为缓冲
        container.style.height = `${dynamicHeight}px`;
        container.style.maxHeight = `${maxHeight}px`;
        
        virtualScrollManager.updateData(data, ListState.totalCount, true);
        
        if (resetScroll) {
            container.scrollTop = 0;
        }
    }
    
    document.getElementById('count_text').innerText = ListState.totalCount;
    const stats = calculateStats(data);
    document.getElementById('money_text').innerText = `$${stats.totalAmount.toFixed(2)}`;
    if (typeof updatePieChartThrottled === 'function') {
        updatePieChartThrottled(data);
    } else {
        updatePieChart(data);
    }
    
    if (typeof window.updateSearchResultHint === 'function') {
        window.updateSearchResultHint();
    }
    
    if (typeof window.updateBatchActionBar === 'function') {
        window.updateBatchActionBar();
    }
}

// 渲染分页控件（增强版：完整页码导航、跳转功能、加载状态处理）
function renderPaginationControls() {
    const paginationContainer = document.getElementById('pagination-container');
    if (!paginationContainer) return;
    
    // 【内存泄漏修复】清理旧的分页控件监听器
    EventListenerManager.clearByPrefix('pagination_');
    
    // 【数值验证】确保页码和数据计数的有效性
    const totalCount = Math.max(0, ListState.totalCount || 0);
    const pageSize = Math.max(1, ListState.pagination.pageSize || 20);
    const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
    let currentPage = Math.max(1, Math.min(ListState.pagination.page || 1, totalPages));
    
    // 如果当前页超出范围，自动修正
    if (currentPage > totalPages) {
        currentPage = totalPages;
        ListState.pagination.page = currentPage;
    }
    
    // 【加载状态处理】避免重复请求
    const isLoading = ListState.isLoading || false;
    
    // 计算显示的页码范围（显示当前页前后各2页，最多显示7个页码按钮）
    const maxVisiblePages = 7;
    let startPage = Math.max(1, currentPage - Math.floor(maxVisiblePages / 2));
    let endPage = Math.min(totalPages, startPage + maxVisiblePages - 1);
    
    // 如果右侧页码不足，向左调整
    if (endPage - startPage < maxVisiblePages - 1) {
        startPage = Math.max(1, endPage - maxVisiblePages + 1);
    }
    
    let paginationHTML = `
        <div class="flex items-center justify-between p-4 border-t border-slate-100 dark:border-slate-700">
            <div class="flex items-center space-x-2">
                <span class="text-sm text-slate-600 dark:text-slate-100 font-medium">显示行数：</span>
                <select id="page-size-select" class="text-sm border-2 border-slate-300 dark:border-slate-500 rounded-md px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white dark:bg-slate-700 text-slate-800 dark:text-white font-medium ${isLoading ? 'opacity-50 cursor-not-allowed' : ''}" ${isLoading ? 'disabled' : ''}>
    `;
    
    ListState.pagination.pageSizeOptions.forEach(size => {
        paginationHTML += `<option value="${size}" ${ListState.pagination.pageSize === size ? 'selected' : ''}>${size}</option>`;
    });
    
    paginationHTML += `
                </select>
                <span class="text-sm text-slate-600 dark:text-slate-100 font-medium">共 ${totalCount} 条记录，第 ${currentPage} / ${totalPages} 页</span>
            </div>
            <div class="flex items-center space-x-1">
                <!-- 首页按钮 -->
                <button id="first-page" class="px-3 py-1.5 bg-white dark:bg-slate-700 border-2 border-slate-300 dark:border-slate-500 rounded-md text-sm text-slate-700 dark:text-white font-medium hover:bg-slate-50 dark:hover:bg-slate-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors ${isLoading ? 'opacity-50 cursor-not-allowed' : ''}" 
                    ${currentPage === 1 || isLoading ? 'disabled' : ''} title="首页">
                    <svg class="w-4 h-4 inline" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 19l-7-7 7-7m8 14l-7-7 7-7"></path>
                    </svg>
                </button>
                <!-- 上一页按钮 -->
                <button id="prev-page" class="px-3 py-1.5 bg-white dark:bg-slate-700 border-2 border-slate-300 dark:border-slate-500 rounded-md text-sm text-slate-700 dark:text-white font-medium hover:bg-slate-50 dark:hover:bg-slate-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors ${isLoading ? 'opacity-50 cursor-not-allowed' : ''}" 
                    ${currentPage === 1 || isLoading ? 'disabled' : ''} title="上一页">
                    <svg class="w-4 h-4 inline" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7"></path>
                    </svg>
                </button>
    `;
    
    // 【完整页码导航】生成页码按钮
    if (startPage > 1) {
        paginationHTML += `
            <button class="page-number-btn px-3 py-1.5 bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-600 rounded-md text-sm hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors ${isLoading ? 'opacity-50 cursor-not-allowed' : ''}" 
                data-page="1" ${isLoading ? 'disabled' : ''}>1</button>
        `;
        if (startPage > 2) {
            paginationHTML += `<span class="px-2 text-slate-400">...</span>`;
        }
    }
    
    for (let i = startPage; i <= endPage; i++) {
        const isActive = i === currentPage;
        paginationHTML += `
            <button class="page-number-btn px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${isLoading ? 'opacity-50 cursor-not-allowed' : ''} ${
                isActive 
                    ? 'bg-blue-600 text-white border-2 border-blue-600 shadow-sm' 
                    : 'bg-white dark:bg-slate-700 border-2 border-slate-300 dark:border-slate-500 text-slate-700 dark:text-white hover:bg-slate-50 dark:hover:bg-slate-600'
            }" 
                data-page="${i}" ${isLoading ? 'disabled' : ''} ${isActive ? 'aria-current="page"' : ''}>
                ${i}
            </button>
        `;
    }
    
    if (endPage < totalPages) {
        if (endPage < totalPages - 1) {
            paginationHTML += `<span class="px-2 text-slate-400">...</span>`;
        }
        paginationHTML += `
            <button class="page-number-btn px-3 py-1.5 bg-white dark:bg-slate-700 border-2 border-slate-300 dark:border-slate-500 rounded-md text-sm text-slate-700 dark:text-white font-medium hover:bg-slate-50 dark:hover:bg-slate-600 transition-colors ${isLoading ? 'opacity-50 cursor-not-allowed' : ''}" 
                data-page="${totalPages}" ${isLoading ? 'disabled' : ''}>${totalPages}</button>
        `;
    }
    
    paginationHTML += `
                <!-- 下一页按钮 -->
                <button id="next-page" class="px-3 py-1.5 bg-white dark:bg-slate-700 border-2 border-slate-300 dark:border-slate-500 rounded-md text-sm text-slate-700 dark:text-white font-medium hover:bg-slate-50 dark:hover:bg-slate-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors ${isLoading ? 'opacity-50 cursor-not-allowed' : ''}" 
                    ${currentPage >= totalPages || isLoading ? 'disabled' : ''} title="下一页">
                    <svg class="w-4 h-4 inline" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"></path>
                    </svg>
                </button>
                <!-- 末页按钮 -->
                <button id="last-page" class="px-3 py-1.5 bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-600 rounded-md text-sm hover:bg-slate-50 dark:hover:bg-slate-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors ${isLoading ? 'opacity-50 cursor-not-allowed' : ''}" 
                    ${currentPage >= totalPages || isLoading ? 'disabled' : ''} title="末页">
                    <svg class="w-4 h-4 inline" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 5l7 7-7 7M5 5l7 7-7 7"></path>
                    </svg>
                </button>
                <!-- 页码跳转输入框 -->
                <div class="flex items-center space-x-1 ml-2 pl-2 border-l border-slate-300 dark:border-slate-600">
                    <span class="text-sm text-slate-600 dark:text-slate-400">跳转到</span>
                    <input type="number" id="page-jump-input" 
                        class="w-16 px-2 py-1.5 text-sm border border-slate-300 dark:border-slate-600 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white dark:bg-slate-800 text-slate-800 dark:text-slate-200 ${isLoading ? 'opacity-50 cursor-not-allowed' : ''}" 
                        min="1" max="${totalPages}" value="${currentPage}" ${isLoading ? 'disabled' : ''}>
                    <span class="text-sm text-slate-600 dark:text-slate-400">页</span>
                    <button id="page-jump-btn" class="px-3 py-1.5 bg-blue-600 text-white rounded-md text-sm hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors ${isLoading ? 'opacity-50 cursor-not-allowed' : ''}" 
                        ${isLoading ? 'disabled' : ''}>跳转</button>
                </div>
            </div>
        </div>
    `;
    
    paginationContainer.innerHTML = paginationHTML;
    
    // 【加载状态处理】避免重复请求 - 绑定事件处理器
    if (isLoading) {
        return; // 如果正在加载，不绑定事件，避免重复请求
    }
    
    // 每页显示数量选择
    const pageSizeSelect = document.getElementById('page-size-select');
    if (pageSizeSelect) {
        EventListenerManager.add(
            pageSizeSelect,
            'change',
            (e) => {
                if (ListState.isLoading) return;
                const newPageSize = parseInt(e.target.value);
                if (isNaN(newPageSize) || newPageSize < 1) return;
                ListState.pagination.pageSize = newPageSize;
                ListState.pagination.page = 1;
                localStorage.setItem('wh_claims_pageSize', ListState.pagination.pageSize);
                fetchTableData(false, false, 1, false);
            },
            'pagination_pageSize'
        );
    }
    
    // 首页按钮
    const firstPageBtn = document.getElementById('first-page');
    if (firstPageBtn) {
        EventListenerManager.add(
            firstPageBtn,
            'click',
            () => {
                if (ListState.isLoading || currentPage === 1) return;
                fetchTableData(false, false, 1, false);
            },
            'pagination_first'
        );
    }
    
    // 上一页按钮
    const prevPageBtn = document.getElementById('prev-page');
    if (prevPageBtn) {
        EventListenerManager.add(
            prevPageBtn,
            'click',
            () => {
                if (ListState.isLoading || currentPage <= 1) return;
                fetchTableData(false, false, currentPage - 1, false);
            },
            'pagination_prev'
        );
    }
    
    // 下一页按钮
    const nextPageBtn = document.getElementById('next-page');
    if (nextPageBtn) {
        EventListenerManager.add(
            nextPageBtn,
            'click',
            () => {
                if (ListState.isLoading || currentPage >= totalPages) return;
                fetchTableData(false, false, currentPage + 1, false);
            },
            'pagination_next'
        );
    }
    
    // 末页按钮
    const lastPageBtn = document.getElementById('last-page');
    if (lastPageBtn) {
        EventListenerManager.add(
            lastPageBtn,
            'click',
            () => {
                if (ListState.isLoading || currentPage >= totalPages) return;
                fetchTableData(false, false, totalPages, false);
            },
            'pagination_last'
        );
    }
    
    // 页码按钮
    const pageNumberBtns = document.querySelectorAll('.page-number-btn');
    pageNumberBtns.forEach((btn, index) => {
        EventListenerManager.add(
            btn,
            'click',
            () => {
                if (ListState.isLoading) return;
                const targetPage = parseInt(btn.getAttribute('data-page'));
                if (isNaN(targetPage) || targetPage < 1 || targetPage > totalPages) return;
                if (targetPage !== currentPage) {
                    fetchTableData(false, false, targetPage, false);
                }
            },
            `pagination_page_${index}`
        );
    });
    
    // 跳转输入框
    const jumpInput = document.getElementById('page-jump-input');
    const jumpBtn = document.getElementById('page-jump-btn');
    
    if (jumpInput) {
        EventListenerManager.add(
            jumpInput,
            'keypress',
            (e) => {
                if (e.key === 'Enter' && jumpBtn) {
                    jumpBtn.click();
                }
            },
            'pagination_jump_input'
        );
    }
    
    if (jumpBtn) {
        EventListenerManager.add(
            jumpBtn,
            'click',
            () => {
                if (ListState.isLoading) return;
                const targetPage = parseInt(jumpInput.value);
                if (isNaN(targetPage) || targetPage < 1 || targetPage > totalPages) {
                    if (typeof showToast === 'function') {
                        showToast(`请输入有效的页码（1-${totalPages}）`, 'error');
                    } else {
                        alert(`请输入有效的页码（1-${totalPages}）`);
                    }
                    jumpInput.value = currentPage;
                    return;
                }
                if (targetPage !== currentPage) {
                    fetchTableData(false, false, targetPage, false);
                }
            },
            'pagination_jump_btn'
        );
    }
}

// 获取表单数据
function getFormDataFromInput() {
    return {
        id: editingId || generateUUID(),
        cust_name: document.getElementById('cust_name').value,
        contact_name: document.getElementById('contact_name').value,
        contact_info: document.getElementById('contact_info').value,
        store_by: document.getElementById('store_by').value,
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
        // entry_date 现在是 timestamp 类型，如果用户选择了日期，转换为当天的开始时间（00:00:00）
        // 如果没有选择，使用当前时间戳
        entry_date: (() => {
            const dateValue = document.getElementById('entry_date').value;
            if (dateValue) {
                // 将日期字符串转换为当天的开始时间戳
                return new Date(dateValue + 'T00:00:00').toISOString();
            } else {
                // 使用当前时间戳
                return new Date().toISOString();
            }
        })(),
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
            const oldStatus = database[index].process_status;
            database[index] = record;
            await updateDataInSupabase(editingId, record);
            localStorage.setItem('wh_claims_db_pro', JSON.stringify(database));
            
            // 编辑成功后，重置排序为默认值
            resetSortingToDefault();
            
            fetchTableData();
            renderKanban();
            
            // 如果状态发生变化，更新状态统计
            if (oldStatus !== record.process_status && typeof updateStatusCounts === 'function') {
                updateStatusCounts();
            }
            
            showToast('数据修改已保存', 'success');
            cancelEditMode();
            return;
        }
    } else {
        database.unshift(record);
        await saveDataToSupabase();
        localStorage.setItem('wh_claims_db_pro', JSON.stringify(database));
        
        // 新建成功后，重置排序为默认值
        resetSortingToDefault();
        
        fetchTableData();
        renderKanban();
        
        // 新增数据后，更新状态统计
        if (typeof updateStatusCounts === 'function') {
            updateStatusCounts();
        }
        
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

// ============================================
// 编辑弹窗组件封装函数
// ============================================

/**
 * 创建表单输入组件
 * @param {Object} config - 组件配置
 */
function createFormInput(config) {
    const container = document.createElement('div');
    
    // 创建标签
    const label = document.createElement('label');
    label.className = 'input-group-label';
    if (config.required) {
        label.innerHTML = `<span class="text-red-600 font-extrabold mr-1">*</span>${config.label}：`;
    } else {
        label.textContent = `${config.label}：`;
    }
    
    // 根据类型创建输入元素
    let input;
    if (config.type === 'textarea') {
        input = document.createElement('textarea');
        input.rows = config.rows || 2;
        input.className = 'form-textarea bg-white dark:bg-slate-700 dark:border-slate-600';
    } else if (config.type === 'select') {
        input = document.createElement('select');
        input.className = 'form-input bg-white dark:bg-slate-700 dark:border-slate-600 cursor-pointer';
        if (config.options) {
            config.options.forEach(option => {
                const opt = document.createElement('option');
                if (typeof option === 'string') {
                    opt.value = option;
                    opt.textContent = option;
                } else {
                    opt.value = option.value;
                    opt.textContent = option.label;
                }
                input.appendChild(opt);
            });
        }
    } else {
        input = document.createElement('input');
        input.type = config.type || 'text';
        input.className = 'form-input bg-white dark:bg-slate-700 dark:border-slate-600';
        if (config.step) input.step = config.step;
        if (config.placeholder) input.placeholder = config.placeholder;
    }
    
    input.id = config.id;
    input.required = config.required || false;
    if (config.value !== undefined) input.value = config.value;
    if (config.readonly) input.readOnly = true;
    
    container.appendChild(label);
    container.appendChild(input);
    
    return container;
}

/**
 * 创建信息分组卡片
 * @param {Object} config - 分组配置
 */
function createFormSection(config) {
    const section = document.createElement('div');
    section.className = 'edit-form-section';
    
    // 分组标题
    const title = document.createElement('h3');
    title.className = 'edit-form-section-title';
    title.innerHTML = `
        <svg class="edit-form-section-icon" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            ${config.icon || '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"></path>'}
        </svg>
        <span>${config.title}</span>
    `;
    
    // 字段网格
    const grid = document.createElement('div');
    grid.className = 'edit-form-grid';
    
    // 添加字段
    config.fields.forEach(fieldConfig => {
        const field = createFormInput(fieldConfig);
        grid.appendChild(field);
    });
    
    section.appendChild(title);
    section.appendChild(grid);
    
    return section;
}

// ============================================
// 编辑弹窗管理模块
// ============================================

// 当前编辑的ID（用于弹窗编辑）
let editingModalId = null;
let editingOriginalData = null; // 保存编辑时的原始数据，用于冲突检测

/**
 * 打开编辑弹窗
 * @param {string} id - 记录ID
 */
async function openEditModal(id) {
    const item = database.find(i => i.id === id);
    if (!item) {
        showToast('未找到记录', 'error');
        return;
    }
    
    // 【数据冲突处理】从数据库获取最新数据并保存原始数据
    try {
        const { data: latestRecord, error } = await supabaseClient
            .from('claims_v2')
            .select('*')
            .eq('id', id)
            .single();
        
        if (!error && latestRecord) {
            editingOriginalData = { ...latestRecord };
            // 使用最新数据填充表单
            fillEditForm(latestRecord);
        } else {
            // 如果获取失败，使用本地数据
            editingOriginalData = { ...item };
            fillEditForm(item);
        }
    } catch (error) {
        // 获取失败，使用本地数据
        editingOriginalData = { ...item };
        fillEditForm(item);
    }
    
    // 显示弹窗
    const backdrop = document.getElementById('editModalBackdrop');
    backdrop.classList.remove('hidden');
    requestAnimationFrame(() => {
        backdrop.classList.add('active');
    });
    
    // 保存当前编辑ID
    editingModalId = id;
}

/**
 * 关闭编辑弹窗
 */
function closeEditModal() {
    const backdrop = document.getElementById('editModalBackdrop');
    backdrop.classList.remove('active');
    setTimeout(() => {
        backdrop.classList.add('hidden');
        // 清空表单
        document.getElementById('editClaimForm').reset();
        editingModalId = null;
        editingOriginalData = null; // 清除原始数据
    }, 300);
}

/**
 * 打开提交表格弹窗
 * 如果用户勾选了数据，会在弹窗标题右侧显示选中数据信息（海外仓单号、索赔类型、总赔偿金额）
 * 仅支持勾选一条数据，多条数据会提示错误
 */
function openSubmitFormModal() {
    const backdrop = document.getElementById('submitFormModalBackdrop');
    if (!backdrop) {
        showToast('弹窗元素未找到', 'error');
        return;
    }
    
    // 获取选中的数据
    const checkedBoxes = document.querySelectorAll('.row-checkbox:checked');
    const selectedInfoDiv = document.getElementById('submitFormSelectedInfo');
    
    // 检查是否勾选了多条数据
    if (checkedBoxes.length > 1) {
        showToast('不支持勾选多条数据提交，请检查并重选！', 'error');
        return;
    }
    
    // 如果只勾选了一条数据，显示信息
    if (checkedBoxes.length === 1) {
        const selectedId = checkedBoxes[0].value;
        // 从全局 database 变量获取数据（如果不存在则从 ListState.data 获取）
        const dataSource = (typeof database !== 'undefined' && database.length > 0) 
            ? database 
            : ((typeof ListState !== 'undefined' && ListState.data) ? ListState.data : []);
        const selectedItem = dataSource.find(item => item.id === selectedId);
        
        if (selectedItem && selectedInfoDiv) {
            // 填充数据
            const orderNoEl = document.getElementById('selectedOrderNo');
            const claimTypeEl = document.getElementById('selectedClaimType');
            const claimTotalEl = document.getElementById('selectedClaimTotal');
            
            if (orderNoEl) orderNoEl.textContent = selectedItem.order_no || '-';
            if (claimTypeEl) claimTypeEl.textContent = selectedItem.claim_type || '-';
            
            // 格式化总赔偿金额（包含币种）
            const currency = selectedItem.currency || 'USD';
            const claimTotal = selectedItem.claim_total || '0';
            if (claimTotalEl) claimTotalEl.textContent = `${claimTotal} ${currency}`;
            
            // 重置USD汇率输入框和计算金额
            const usdRateInput = document.getElementById('usdExchangeRate');
            const calculatedAmountEl = document.getElementById('calculatedClaimAmount');
            if (usdRateInput) {
                usdRateInput.value = '';
            }
            if (calculatedAmountEl) {
                calculatedAmountEl.textContent = '-';
            }
            
            // 显示信息区域
            selectedInfoDiv.classList.remove('hidden');
        } else {
            // 如果找不到数据，隐藏信息区域
            if (selectedInfoDiv) {
                selectedInfoDiv.classList.add('hidden');
            }
        }
    } else {
        // 没有勾选，隐藏信息区域
        if (selectedInfoDiv) {
            selectedInfoDiv.classList.add('hidden');
        }
    }
    
    backdrop.classList.remove('hidden');
    requestAnimationFrame(() => {
        backdrop.classList.add('active');
    });
}

/**
 * 关闭提交表格弹窗
 */
function closeSubmitFormModal() {
    const backdrop = document.getElementById('submitFormModalBackdrop');
    if (!backdrop) {
        return;
    }
    
    backdrop.classList.remove('active');
    setTimeout(() => {
        backdrop.classList.add('hidden');
    }, 300);
}

/**
 * 提交表格自动化操作（占位功能）
 */
function submitFormAutoAction() {
    showToast('功能在开发中...', 'info');
}

/**
 * 填充编辑表单
 * @param {Object} item - 数据项
 */
function fillEditForm(item) {
    const formSections = document.getElementById('editFormSections');
    formSections.innerHTML = '';
    
    // 分组1：客户信息
    const section1 = createFormSection({
        title: '客户信息',
        icon: '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"></path>',
        fields: [
            { id: 'edit_cust_name', label: '客户名称 (公司全称)', type: 'text', required: true, value: item.cust_name },
            { id: 'edit_contact_name', label: '联系人', type: 'text', required: true, value: item.contact_name },
            { id: 'edit_contact_info', label: '联系方式', type: 'text', required: true, value: item.contact_info }
        ]
    });
    
    // 分组2：订单信息
    const section2 = createFormSection({
        title: '订单信息',
        icon: '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"></path>',
        fields: [
            { id: 'edit_store_by', label: '所属店铺', type: 'select', required: true, value: item.store_by || '', options: ['XKY', 'SZ POWCHO【SHEIN】', 'CRQ', 'TEMU Love pin local【XKY】', 'Your love local', 'TEMU（Domiciliary local）KDM', 'TEMU（Electronically local）KDM', 'CRRQ', '美半包2店', '美半包1店'] },
            { id: 'edit_order_no', label: '海外仓单号（OBS出库号）', type: 'text', required: true, value: item.order_no, placeholder: '系统生成的唯一单号' },
            { id: 'edit_tracking_no', label: '物流运单号', type: 'text', required: true, value: item.tracking_no, placeholder: '头程/尾程物流单号' },
            { id: 'edit_ship_date', label: '发货日期', type: 'date', required: true, value: item.ship_date ? item.ship_date.substring(0, 10) : '' },
            { id: 'edit_sku', label: '订单 SKU', type: 'text', required: true, value: item.sku, placeholder: '货物发货SKU' },
            { id: 'edit_warehouse', label: '发货仓', type: 'select', required: true, value: item.warehouse, options: ['美西-4仓', '美西-2仓', '美东-4仓', '美西-1仓'] }
        ]
    });
    
    // 分组3：索赔信息
    const section3 = createFormSection({
        title: '索赔信息',
        icon: '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"></path>',
        fields: [
            { id: 'edit_claim_type', label: '索赔类型', type: 'select', required: true, value: item.claim_type, options: ['货物损坏', '丢失', '延误', '库存不符', '错发', '发货数量不符'] },
            { id: 'edit_liable_party', label: '责任方判定', type: 'select', value: item.liable_party || '待核实', options: ['待核实', '海外仓责任', '物流商责任', '客户责任'] },
            { id: 'edit_description', label: '问题描述', type: 'textarea', required: true, value: item.description, rows: 3, placeholder: '详细说明异常情况（如损坏程度、延误天数等）' }
        ]
    });
    
    // 分组4：金额信息
    const section4 = createFormSection({
        title: '金额信息',
        icon: '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path>',
        fields: [
            { id: 'edit_currency', label: '赔偿币种', type: 'select', value: item.currency || 'USD', options: [{ value: 'USD', label: 'USD ($)' }, { value: 'EUR', label: 'EUR (€)' }, { value: 'GBP', label: 'GBP (£)' }, { value: 'CNY', label: 'CNY (¥)' }] },
            { id: 'edit_val_amount', label: '货物声明价值', type: 'number', required: true, value: item.val_amount, step: '0.01', placeholder: '商品采购价或投保价值' },
            { id: 'edit_claim_qty', label: '索赔数量', type: 'number', required: true, value: item.claim_qty, placeholder: '需赔付的商品数量' },
            { id: 'edit_claim_ratio', label: '赔偿比例 (%)', type: 'number', required: true, value: item.claim_ratio || '100' },
            { id: 'edit_claim_total', label: '总赔偿金额', type: 'number', required: true, value: item.claim_total, step: '0.01', placeholder: '最高赔偿100USD' }
        ]
    });
    
    // 分组5：附件信息
    const section5 = createFormSection({
        title: '附件信息',
        icon: '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13"></path>',
        fields: [
            { id: 'edit_attachments', label: '附件上传', type: 'textarea', value: item.attachments || '', rows: 4, placeholder: '上传图片/视频/物流凭证（用超链接或标注存储路径）' }
        ]
    });
    
    formSections.appendChild(section1);
    formSections.appendChild(section2);
    formSections.appendChild(section3);
    formSections.appendChild(section4);
    formSections.appendChild(section5);
}

/**
 * 获取编辑表单数据
 */
function getEditFormData() {
    return {
        id: editingModalId,
        cust_name: document.getElementById('edit_cust_name').value,
        contact_name: document.getElementById('edit_contact_name').value,
        contact_info: document.getElementById('edit_contact_info').value,
        store_by: document.getElementById('edit_store_by').value,
        order_no: document.getElementById('edit_order_no').value.trim(),
        tracking_no: document.getElementById('edit_tracking_no').value,
        ship_date: document.getElementById('edit_ship_date').value,
        sku: document.getElementById('edit_sku').value,
        warehouse: document.getElementById('edit_warehouse').value,
        claim_type: document.getElementById('edit_claim_type').value,
        description: document.getElementById('edit_description').value,
        currency: document.getElementById('edit_currency').value,
        val_amount: document.getElementById('edit_val_amount').value,
        claim_qty: document.getElementById('edit_claim_qty').value,
        claim_total: document.getElementById('edit_claim_total').value,
        liable_party: document.getElementById('edit_liable_party').value,
        claim_ratio: document.getElementById('edit_claim_ratio').value,
        attachments: document.getElementById('edit_attachments').value
    };
}

/**
 * 提交编辑表单
 */
async function submitEditForm() {
    const form = document.getElementById('editClaimForm');
    if (!form.checkValidity()) {
        form.reportValidity();
        return;
    }
    
    const inputOrderNo = document.getElementById('edit_order_no').value.trim();
    
    // 检查重复（排除当前编辑项）
    const isDuplicate = database.some(item => {
        if (editingModalId && item.id === editingModalId) return false;
        return item.order_no === inputOrderNo;
    });
    
    if (isDuplicate) {
        showToast('错误：该海外仓单号已存在，请勿重复添加！', 'error');
        return;
    }
    
    const record = getEditFormData();
    const index = database.findIndex(i => i.id === editingModalId);
    
    if (index !== -1) {
        // 保留原始记录中的状态信息字段（这些字段在编辑表单中已移除，但需要保留原始值）
        const originalItem = database[index];
        record.entry_date = originalItem.entry_date;
        record.process_status = originalItem.process_status;
        record.remarks = originalItem.remarks;
        
        // 【数据冲突处理】传递原始数据用于冲突检测
        const success = await updateDataInSupabase(editingModalId, record, editingOriginalData);
        
        if (success) {
            database[index] = record;
            localStorage.setItem('wh_claims_db_pro', JSON.stringify(database));
            
            // 编辑成功后，重置排序为默认值
            resetSortingToDefault();
            
            // 刷新数据列表
            await fetchTableData(false, true);
            renderKanban();
            
            showToast('数据修改已保存', 'success');
            closeEditModal();
        } else {
            // 更新失败（可能是冲突），不关闭弹窗，让用户决定如何处理
            // 如果用户已解决冲突，会重新调用submitEditForm
        }
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
    document.getElementById('store_by').value = item.store_by || '';
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
        
        // 删除后，更新状态统计
        if (typeof updateStatusCounts === 'function') {
            updateStatusCounts();
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

// 格式化日期显示 (仅日期，YYYY-MM-DD) - 用于发货日期、申请提交日期等
function formatDateDisplay(isoString) {
    if (!isoString) return '';
    
    // 如果已经是 YYYY-MM-DD 格式，直接返回
    if (typeof isoString === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(isoString)) {
        return isoString;
    }
    
    const date = new Date(isoString);
    if (isNaN(date.getTime())) {
        // 如果解析失败，尝试提取日期部分
        if (typeof isoString === 'string' && isoString.length >= 10) {
            return isoString.substring(0, 10);
        }
        return isoString;
    }

    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    
    return `${y}-${m}-${d}`;
}

// 格式化日期时间显示 (YYYY-MM-DD HH:mm:ss) - 用于需要显示时间的场景
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
            // 获取表信息失败，静默处理
        }
    } catch (error) {
        // 检查表结构异常，静默处理
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
    
    // 确保使用默认排序
    resetSortingToDefault();

    const today = new Date();
    const year = today.getFullYear();
    const month = String(today.getMonth() + 1).padStart(2, '0');
    const day = String(today.getDate()).padStart(2, '0');
    document.getElementById('entry_date').value = `${year}-${month}-${day}`;
    
    // 恢复之前打开的视图，如果没有保存的视图则默认显示表单视图
    // 注意：视图恢复会在认证完成后（handleAuthChange中）自动执行
    // 这里只设置默认的导航状态，避免在认证检查期间显示错误的视图
    const savedView = localStorage.getItem('wh_claims_currentView') || 'form';
    
    // 先隐藏所有视图，等待认证完成后再显示正确的视图
    // 这样可以避免在认证检查期间出现视图闪烁
    ['view-form', 'view-data', 'view-kanban', 'view-notice', 'view-users', 'view-login-monitor'].forEach(id => {
        const viewEl = document.getElementById(id);
        if (viewEl) {
            viewEl.classList.add('hidden');
        }
    });
    
    // 设置导航状态（但不切换视图，视图切换会在认证完成后执行）
    updateNavState(savedView);
    
    window.onbeforeunload = () => isFormDirty ? "您有未保存的内容" : undefined;
    
    // 注意：不要在 DOMContentLoaded 时加载公告，因为此时视图是隐藏的
    // 公告列表应该在切换到公告视图时通过 trySwitchView 函数加载
    // 如果当前视图是公告视图，则加载公告
    const noticeView = document.getElementById('view-notice');
    if (noticeView && !noticeView.classList.contains('hidden')) {
        // 只有当前视图是公告视图时才加载
        if (typeof window.loadNotices === 'function') {
            setTimeout(() => {
                window.loadNotices();
            }, 200);
        }
    }
    
    // 【性能优化】智能搜索防抖：根据输入速度动态调整防抖时间
    const searchInput = document.getElementById('searchInput');
    if (searchInput) {
        let searchDebounceTimer = null;
        let lastInputTime = 0;
        
        const handleSmartSearchDebounce = () => {
            const now = Date.now();
            const timeSinceLastInput = lastInputTime > 0 ? now - lastInputTime : Infinity;
            
            // 智能防抖：快速输入时延长防抖时间，慢速输入时缩短防抖时间
            // 如果两次输入间隔小于200ms（快速输入），使用500ms防抖
            // 如果两次输入间隔大于200ms（慢速输入），使用300ms防抖
            const debounceDelay = timeSinceLastInput < 200 ? 500 : 300;
            
            // 清除之前的定时器
            if (searchDebounceTimer) {
                clearTimeout(searchDebounceTimer);
            }
            
            // 设置新的定时器
            searchDebounceTimer = setTimeout(() => {
                applyFilters();
                searchDebounceTimer = null;
            }, debounceDelay);
            
            lastInputTime = now;
        };
        
        searchInput.addEventListener('input', handleSmartSearchDebounce);
    }
    
    // ============================================
    // 【防闪烁优化】页面状态缓存与恢复机制
    // ============================================
    
    // 页面状态缓存键名
    const PAGE_STATE_KEY = 'wh_claims_page_state';
    
    /**
     * 保存页面状态到 localStorage
     */
    function savePageState() {
        try {
            const state = {
                // 数据状态
                data: ListState.data,
                totalCount: ListState.totalCount,
                // 分页状态
                page: ListState.pagination.page,
                pageSize: ListState.pagination.pageSize,
                // 筛选状态
                filters: {
                    status: ListState.filters.status,
                    type: ListState.filters.type,
                    search: ListState.filters.search,
                    advancedFilters: ListState.filters.advancedFilters
                },
                // 排序状态（只保存用户主动设置的排序）
                sorting: ListState.sorting.isUserDefined ? {
                    col: ListState.sorting.col,
                    asc: ListState.sorting.asc,
                    isUserDefined: true
                } : null,
                // 滚动位置
                scrollTop: window.virtualScrollManager ? window.virtualScrollManager.container.scrollTop : 0,
                // 时间戳
                timestamp: Date.now()
            };
            
            localStorage.setItem(PAGE_STATE_KEY, JSON.stringify(state));
        } catch (error) {
            // 保存页面状态失败，静默处理
        }
    }
    
    /**
     * 恢复页面状态
     */
    function restorePageState() {
        try {
            const savedState = localStorage.getItem(PAGE_STATE_KEY);
            if (!savedState) return;
            
            const state = JSON.parse(savedState);
            
            // 检查状态是否过期（超过5分钟）
            const stateAge = Date.now() - (state.timestamp || 0);
            if (stateAge > 5 * 60 * 1000) {
                localStorage.removeItem(PAGE_STATE_KEY);
                return;
            }
            
            // 恢复分页状态
            if (state.page) ListState.pagination.page = state.page;
            if (state.pageSize) ListState.pagination.pageSize = state.pageSize;
            
            // 恢复筛选状态
            if (state.filters) {
                Object.assign(ListState.filters, state.filters);
            }
            
            // 恢复排序状态（只恢复用户主动设置的排序）
            if (state.sorting && state.sorting.isUserDefined) {
                ListState.sorting.col = state.sorting.col;
                ListState.sorting.asc = state.sorting.asc;
                ListState.sorting.isUserDefined = true;
            } else {
                // 如果没有保存的用户排序，使用默认排序
                resetSortingToDefault();
            }
            
            // 【P0修复】如果恢复了状态筛选，同步更新按钮样式
            // 确保UI状态与数据状态完全同步
            if (ListState.filters.status) {
                const status = ListState.filters.status;
                // 使用工具函数同步按钮样式
                if (typeof window.syncStatusButtonStyle === 'function') {
                    window.syncStatusButtonStyle(status);
                } else {
                    // 降级方案：直接更新按钮样式
                    const statusMap = {'待审核':'pending','处理中':'processing','等待赔付':'waiting','已赔付':'paid','已驳回':'rejected'};
                    const suffix = status === 'all' ? 'all' : statusMap[status];
                    
                    // 移除所有按钮的激活状态
                    document.querySelectorAll('.filter-btn').forEach(btn => {
                        btn.classList.remove('bg-blue-500', 'text-white', 'hover:bg-blue-600');
                        btn.classList.add('bg-gray-100', 'dark:bg-slate-700', 'text-gray-700', 'dark:text-slate-300', 'hover:bg-gray-200', 'dark:hover:bg-slate-600');
                    });
                    
                    // 激活当前状态的按钮
                    const activeBtn = document.getElementById(`tab-${suffix}`);
                    if (activeBtn) {
                        activeBtn.classList.remove('bg-gray-100', 'dark:bg-slate-700', 'text-gray-700', 'dark:text-slate-300', 'hover:bg-gray-200', 'dark:hover:bg-slate-600');
                        activeBtn.classList.add('bg-blue-500', 'text-white', 'hover:bg-blue-600');
                    }
                }
            } else {
                // 【P2-1优化】如果没有状态筛选，使用工具函数确保"全部"按钮是激活状态
                if (typeof window.syncStatusButtonStyle === 'function') {
                    window.syncStatusButtonStyle('all');
                } else {
                    // 降级方案：直接更新按钮样式
                    const allBtn = document.getElementById('tab-all');
                    if (allBtn) {
                        document.querySelectorAll('.filter-btn').forEach(btn => {
                            btn.classList.remove('bg-blue-500', 'text-white', 'hover:bg-blue-600');
                            btn.classList.add('bg-gray-100', 'dark:bg-slate-700', 'text-gray-700', 'dark:text-slate-300', 'hover:bg-gray-200', 'dark:hover:bg-slate-600');
                        });
                        allBtn.classList.remove('bg-gray-100', 'dark:bg-slate-700', 'text-gray-700', 'dark:text-slate-300', 'hover:bg-gray-200', 'dark:hover:bg-slate-600');
                        allBtn.classList.add('bg-blue-500', 'text-white', 'hover:bg-blue-600');
                    }
                }
            }
            
            // 【P1-1修复】恢复数据逻辑：无论是否有状态筛选，都重新获取数据，确保数据最新
            // 只在网络不可用时才使用缓存数据作为降级方案
            if (state.data && state.data.length > 0) {
                // 检查当前是否有状态筛选
                const hasActiveStatusFilter = ListState.filters.status && 
                    ListState.filters.status !== 'all' && 
                    ListState.filters.status !== undefined && 
                    ListState.filters.status !== null;
                
                if (hasActiveStatusFilter) {
                    // 有状态筛选，直接重新获取数据（不显示缓存，避免数据不一致）
                    if (typeof window.fetchTableData === 'function') {
                        window.fetchTableData(false, true);
                    } else if (typeof fetchTableData === 'function') {
                        fetchTableData(false, true);
                    }
                    return; // 不恢复缓存数据，直接返回
                } else {
                    // 【P1-1修复】即使没有状态筛选，也重新获取数据，但可以先显示缓存数据提升体验
                    // 先显示缓存数据（提升用户体验，避免白屏）
                    ListState.data = state.data;
                    ListState.totalCount = state.totalCount || state.data.length;
                    
                    // 立即渲染缓存数据
                    requestAnimationFrame(() => {
                        if (typeof renderDatabase === 'function') {
                            renderDatabase();
                        }
                        
                        // 恢复滚动位置
                        if (state.scrollTop && window.virtualScrollManager) {
                            requestAnimationFrame(() => {
                                window.virtualScrollManager.container.scrollTop = state.scrollTop;
                            });
                        }
                    });
                    
                    // 然后在后台获取最新数据（静默更新）
                    setTimeout(() => {
                        if (typeof window.fetchTableData === 'function') {
                            window.fetchTableData(false, true);
                        } else if (typeof fetchTableData === 'function') {
                            fetchTableData(false, true);
                        }
                    }, 500);
                    
                    return;
                }
            } else {
                // 如果没有缓存数据，直接获取最新数据
                if (typeof window.fetchTableData === 'function') {
                    window.fetchTableData(false, true);
                } else if (typeof fetchTableData === 'function') {
                    fetchTableData(false, true);
                }
            }
        } catch (error) {
            // 恢复页面状态失败，静默处理
        }
    }
    
    // 监听页面可见性变化（切换标签页时）
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
            // 页面隐藏时保存状态
            savePageState();
        } else {
            // 页面显示时恢复状态（可选，根据需求决定是否自动恢复）
            // restorePageState();
        }
    });
    
    // 监听页面卸载前事件
    window.addEventListener('beforeunload', () => {
        savePageState();
    });
    
    // 页面加载完成后，尝试恢复状态（仅在特定条件下）
    // 注意：这里不自动恢复，因为可能会覆盖最新的数据
    // 如果需要自动恢复，可以在特定场景下调用 restorePageState()
    
    // 暴露恢复函数到全局，供需要时手动调用
    if (typeof window !== 'undefined') {
        window.restorePageState = restorePageState;
        window.savePageState = savePageState;
        window.renderDatabase = renderDatabase;
        window.renderPaginationControls = renderPaginationControls;
        window.showSkeletonTable = showSkeletonTable;
        window.hideSkeletonTable = hideSkeletonTable;
        window.showSkeletonTableUsers = showSkeletonTableUsers;
        window.hideSkeletonTableUsers = hideSkeletonTableUsers;
        window.resetSortingToDefault = resetSortingToDefault;
    }
    
    // 【修复】页面加载时初始化批量操作工具栏状态（确保初始隐藏）
    if (typeof window.updateBatchActionBar === 'function') {
        window.updateBatchActionBar();
    }
    
    // ============================================
    // 编辑弹窗事件绑定
    // ============================================
    
    // 关闭按钮
    const editModalCloseBtn = document.getElementById('editModalCloseBtn');
    if (editModalCloseBtn) {
        editModalCloseBtn.addEventListener('click', closeEditModal);
    }
    
    // 取消按钮
    const editModalCancelBtn = document.getElementById('editModalCancelBtn');
    if (editModalCancelBtn) {
        editModalCancelBtn.addEventListener('click', closeEditModal);
    }
    
    // 提交按钮
    const editModalSubmitBtn = document.getElementById('editModalSubmitBtn');
    if (editModalSubmitBtn) {
        editModalSubmitBtn.addEventListener('click', submitEditForm);
    }
    
    // 点击背景关闭弹窗
    const editModalBackdrop = document.getElementById('editModalBackdrop');
    if (editModalBackdrop) {
        editModalBackdrop.addEventListener('click', (e) => {
            if (e.target.id === 'editModalBackdrop') {
                closeEditModal();
            }
        });
    }
    
    // ESC 键关闭弹窗
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            const backdrop = document.getElementById('editModalBackdrop');
            if (backdrop && backdrop.classList.contains('active')) {
                closeEditModal();
            }
            const submitFormBackdrop = document.getElementById('submitFormModalBackdrop');
            if (submitFormBackdrop && submitFormBackdrop.classList.contains('active')) {
                closeSubmitFormModal();
            }
        }
    });
    
    // 提交表格弹窗事件绑定
    const submitFormModalCloseBtn = document.getElementById('submitFormModalCloseBtn');
    if (submitFormModalCloseBtn) {
        submitFormModalCloseBtn.addEventListener('click', closeSubmitFormModal);
    }
    
    // 复制海外仓单号按钮事件绑定
    const copyOrderNoBtn = document.getElementById('copyOrderNoBtn');
    if (copyOrderNoBtn) {
        copyOrderNoBtn.addEventListener('click', function() {
            const orderNo = document.getElementById('selectedOrderNo')?.textContent || '-';
            
            // 只复制海外仓单号，如果包含冒号则截断后面的内容
            let copyText = orderNo;
            if (copyText.includes('：')) {
                copyText = copyText.split('：')[0];
            } else if (copyText.includes(':')) {
                copyText = copyText.split(':')[0];
            }
            
            copyToClipboard(copyText, '海外仓单号已复制到剪贴板');
        });
    }
    
    // 复制客户代码按钮事件绑定
    const copyCustomerCodeBtn = document.getElementById('copyCustomerCodeBtn');
    if (copyCustomerCodeBtn) {
        copyCustomerCodeBtn.addEventListener('click', function() {
            copyToClipboard('1535172', '客户代码已复制到剪贴板');
        });
    }
    
    // 复制公司名称按钮事件绑定
    const copyCompanyNameBtn = document.getElementById('copyCompanyNameBtn');
    if (copyCompanyNameBtn) {
        copyCompanyNameBtn.addEventListener('click', function() {
            copyToClipboard('深圳市信凯源科技有限公司', '公司名称已复制到剪贴板');
        });
    }
    
    // 复制索赔金额(￥)按钮事件绑定
    const copyClaimAmountBtn = document.getElementById('copyClaimAmountBtn');
    if (copyClaimAmountBtn) {
        copyClaimAmountBtn.addEventListener('click', function() {
            const calculatedAmountEl = document.getElementById('calculatedClaimAmount');
            const amountText = calculatedAmountEl?.textContent || '-';
            
            // 只复制数值，如果显示"-"则不复制
            if (amountText === '-') {
                showToast('请先输入USD汇率并计算索赔金额', 'error');
                return;
            }
            
            // 提取数值部分（去除可能的符号和单位）
            const amountValue = amountText.trim();
            copyToClipboard(amountValue, '索赔金额已复制到剪贴板');
        });
    }
    
    // USD汇率输入框变化事件：计算索赔金额(￥)
    const usdExchangeRateInput = document.getElementById('usdExchangeRate');
    if (usdExchangeRateInput) {
        usdExchangeRateInput.addEventListener('input', function() {
            calculateClaimAmountCNY();
        });
        
        // 限制小数点后两位
        usdExchangeRateInput.addEventListener('blur', function() {
            const value = parseFloat(this.value);
            if (!isNaN(value)) {
                this.value = value.toFixed(2);
                calculateClaimAmountCNY();
            }
        });
    }
    
    /**
     * 计算索赔金额(￥) = 总赔偿金额 * USD汇率
     */
    function calculateClaimAmountCNY() {
        const usdRateInput = document.getElementById('usdExchangeRate');
        const claimTotalEl = document.getElementById('selectedClaimTotal');
        const calculatedAmountEl = document.getElementById('calculatedClaimAmount');
        
        if (!usdRateInput || !claimTotalEl || !calculatedAmountEl) return;
        
        const usdRate = parseFloat(usdRateInput.value);
        const claimTotalText = claimTotalEl.textContent || '0';
        
        // 提取总赔偿金额数值（去除币种）
        const claimTotalMatch = claimTotalText.match(/^([\d.]+)/);
        const claimTotal = claimTotalMatch ? parseFloat(claimTotalMatch[1]) : 0;
        
        if (!isNaN(usdRate) && !isNaN(claimTotal) && usdRate > 0) {
            const calculatedAmount = (claimTotal * usdRate).toFixed(2);
            calculatedAmountEl.textContent = calculatedAmount;
        } else {
            calculatedAmountEl.textContent = '-';
        }
    }
    
    /**
     * 复制文本到剪贴板的通用函数
     */
    function copyToClipboard(text, successMessage) {
        if (navigator.clipboard && window.isSecureContext) {
            navigator.clipboard.writeText(text).then(() => {
                showToast(successMessage, 'success');
            }).catch(err => {
                // 降级方案
                fallbackCopyToClipboard(text, successMessage);
            });
        } else {
            // 降级方案
            fallbackCopyToClipboard(text, successMessage);
        }
    }
    
    /**
     * 降级复制方案
     */
    function fallbackCopyToClipboard(text, successMessage) {
        const textArea = document.createElement('textarea');
        textArea.value = text;
        textArea.style.position = 'fixed';
        textArea.style.opacity = '0';
        document.body.appendChild(textArea);
        textArea.select();
        try {
            document.execCommand('copy');
            showToast(successMessage, 'success');
        } catch (e) {
            showToast('复制失败，请手动复制', 'error');
        }
        document.body.removeChild(textArea);
    }
    
    const submitFormAutoBtn = document.getElementById('submitFormAutoBtn');
    if (submitFormAutoBtn) {
        submitFormAutoBtn.addEventListener('click', submitFormAutoAction);
    }
    
    // 点击背景关闭提交表格弹窗
    const submitFormModalBackdrop = document.getElementById('submitFormModalBackdrop');
    if (submitFormModalBackdrop) {
        submitFormModalBackdrop.addEventListener('click', (e) => {
            if (e.target.id === 'submitFormModalBackdrop') {
                closeSubmitFormModal();
            }
        });
    }
});

