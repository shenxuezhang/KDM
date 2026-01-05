/**
 * 实时数据同步模块
 * 使用Supabase Realtime实现多用户数据同步
 */

// 实时订阅管理器
class RealtimeSubscriptionManager {
    constructor() {
        this.channel = null;
        this.isSubscribed = false;
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 5;
        this.reconnectDelay = 1000;
        this.eventQueue = [];
        this.processQueueTimer = null;
        this.isProcessing = false;
        this.refreshTimer = null;
    }

    /**
     * 初始化并启动订阅
     */
    async subscribe() {
        if (!supabaseClient) {
            return false;
        }

        if (this.isSubscribed && this.channel) {
            return true;
        }

        try {
            this.channel = supabaseClient
                .channel('claims_v2_changes')
                .on(
                    'postgres_changes',
                    {
                        event: '*',
                        schema: 'public',
                        table: 'claims_v2'
                    },
                    (payload) => {
                        this.handleChange(payload);
                    }
                )
                .subscribe((status) => {
                    this.handleSubscriptionStatus(status);
                });

            this.isSubscribed = true;
            this.reconnectAttempts = 0;
            return true;
        } catch (error) {
            this.handleReconnect();
            return false;
        }
    }

    /**
     * 处理订阅状态变化
     */
    handleSubscriptionStatus(status) {
        switch (status) {
            case 'SUBSCRIBED':
                this.isSubscribed = true;
                this.reconnectAttempts = 0;
                break;
            case 'CHANNEL_ERROR':
            case 'TIMED_OUT':
            case 'CLOSED':
                this.isSubscribed = false;
                this.handleReconnect();
                break;
        }
    }

    /**
     * 处理数据变更事件
     */
    handleChange(payload) {
        if (this.isProcessing) {
            this.eventQueue.push(payload);
            return;
        }

        this.eventQueue.push(payload);
        
        if (this.processQueueTimer) {
            clearTimeout(this.processQueueTimer);
        }
        
        // 增加延迟，合并短时间内的多个事件
        this.processQueueTimer = setTimeout(() => {
            this.processEventQueue();
        }, 500); // 延迟500ms，合并多个事件
    }

    /**
     * 批量处理事件队列
     */
    processEventQueue() {
        if (this.eventQueue.length === 0 || this.isProcessing) return;

        this.isProcessing = true;
        const events = [...this.eventQueue];
        this.eventQueue = [];
        this.processQueueTimer = null;

        const inserts = events.filter(e => e.eventType === 'INSERT');
        const updates = events.filter(e => e.eventType === 'UPDATE');
        const deletes = events.filter(e => e.eventType === 'DELETE');

        if (inserts.length > 0) this.handleInserts(inserts);
        if (updates.length > 0) this.handleUpdates(updates);
        if (deletes.length > 0) this.handleDeletes(deletes);

        this.isProcessing = false;

        if (this.eventQueue.length > 0) {
            this.processQueueTimer = setTimeout(() => {
                this.processEventQueue();
            }, 100);
        }
    }

    /**
     * 处理 INSERT 事件
     */
    handleInserts(events) {
        let hasNewData = false;
        
        events.forEach(event => {
            const newRecord = event.new;
            
            if (this.shouldIncludeRecord(newRecord)) {
                hasNewData = true;
            }
        });

        if (hasNewData) {
            this.clearCacheAndRefresh();
        }
    }

    /**
     * 处理 UPDATE 事件
     */
    handleUpdates(events) {
        let updatedIds = new Set();
        
        events.forEach(event => {
            const updatedRecord = event.new;
            const oldRecord = event.old;
            
            const shouldInclude = this.shouldIncludeRecord(updatedRecord);
            const wasIncluded = this.isRecordInList(oldRecord.id);
            
            if (shouldInclude || wasIncluded) {
                updatedIds.add(updatedRecord.id);
            }
        });

        if (updatedIds.size > 0) {
            // 只更新变化的记录
            if (updatedIds.size < ListState.data.length * 0.3) {
                // 小范围更新，使用增量更新
                this.updateRecords(Array.from(updatedIds));
            } else {
                // 大范围更新，使用全量刷新
                this.clearCacheAndRefresh();
            }
        }
    }

    /**
     * 处理 DELETE 事件
     */
    handleDeletes(events) {
        let needsRefresh = false;
        
        events.forEach(event => {
            const deletedRecord = event.old;
            
            if (this.isRecordInList(deletedRecord.id)) {
                needsRefresh = true;
            }
        });

        if (needsRefresh) {
            this.clearCacheAndRefresh();
        }
    }

    /**
     * 检查记录是否符合当前筛选条件
     */
    shouldIncludeRecord(record) {
        if (!record) return false;
        
        const filters = typeof ListState !== 'undefined' ? ListState.filters : {};
        
        if (filters.status && filters.status !== 'all') {
            if (record.process_status !== filters.status) {
                return false;
            }
        }
        
        if (filters.search && filters.search.trim()) {
            const searchTerm = filters.search.toLowerCase().trim();
            const searchFields = ['order_no', 'tracking_no', 'sku'];
            const matches = searchFields.some(field => {
                const value = record[field] || '';
                return value.toString().toLowerCase().includes(searchTerm);
            });
            if (!matches) return false;
        }
        
        if (filters.advancedFilters) {
            const advFilters = filters.advancedFilters;
            
            if (advFilters.order_no && record.order_no) {
                if (!record.order_no.includes(advFilters.order_no)) {
                    return false;
                }
            }
            
            if (advFilters.tracking_no && record.tracking_no) {
                if (!record.tracking_no.includes(advFilters.tracking_no)) {
                    return false;
                }
            }
            
            if (advFilters.store_by && record.store_by !== advFilters.store_by) {
                return false;
            }
            
            if (advFilters.warehouse && record.warehouse !== advFilters.warehouse) {
                return false;
            }
            
            if (advFilters.sku && record.sku) {
                if (!record.sku.includes(advFilters.sku)) {
                    return false;
                }
            }
        }
        
        return true;
    }

    /**
     * 检查记录是否在当前列表中
     */
    isRecordInList(recordId) {
        if (typeof ListState === 'undefined' || !ListState.data) return false;
        return ListState.data.some(item => item.id === recordId);
    }

    /**
     * 增量更新记录
     */
    async updateRecords(recordIds) {
        if (!recordIds || recordIds.length === 0 || !supabaseClient) return;
        
        try {
            const { data, error } = await supabaseClient
                .from('claims_v2')
                .select('*')
                .in('id', recordIds);
            
            if (error) {
                console.error('Failed to update records:', error);
                return;
            }
            
            // 更新客户端数据
            if (data && data.length > 0) {
                data.forEach(updatedRecord => {
                    const index = ListState.data.findIndex(item => item.id === updatedRecord.id);
                    if (index !== -1) {
                        ListState.data[index] = updatedRecord;
                    } else if (this.shouldIncludeRecord(updatedRecord)) {
                        // 新记录符合条件，添加到列表
                        ListState.data.push(updatedRecord);
                    }
                });
                
                // 重新渲染表格
                if (typeof renderDatabase === 'function') {
                    renderDatabase();
                } else if (typeof window.renderDatabase === 'function') {
                    window.renderDatabase();
                }
            }
        } catch (error) {
            console.error('Error updating records:', error);
        }
    }

    /**
     * 清除缓存并刷新数据
     */
    clearCacheAndRefresh() {
        if (typeof window !== 'undefined') {
            if (typeof window.clearCacheByFilters === 'function') {
                window.clearCacheByFilters(ListState.filters);
            }
        }
        
        // 优化：增加防抖机制，避免短时间内多次触发刷新
        // 只有当距离上次刷新超过3秒时，才会立即触发；否则延迟执行
        const now = Date.now();
        const timeSinceLastRefresh = now - (this.lastRefreshTime || 0);
        const minInterval = 3000; // 最小刷新间隔3秒
        const delay = timeSinceLastRefresh < minInterval ? minInterval - timeSinceLastRefresh : 0;
        
        if (this.refreshTimer) {
            clearTimeout(this.refreshTimer);
        }
        
        this.refreshTimer = setTimeout(() => {
            this.lastRefreshTime = Date.now();
            if (typeof window !== 'undefined') {
                if (typeof window.fetchTableData === 'function') {
                    window.fetchTableData(false, true);
                } else if (typeof fetchTableData === 'function') {
                    fetchTableData(false, true);
                }
            }
        }, delay);
    }

    /**
     * 处理重连
     */
    handleReconnect() {
        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
            return;
        }

        this.reconnectAttempts++;
        const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1);

        setTimeout(() => {
            this.subscribe();
        }, delay);
    }

    /**
     * 取消订阅
     */
    unsubscribe() {
        if (this.processQueueTimer) {
            clearTimeout(this.processQueueTimer);
            this.processQueueTimer = null;
        }

        if (this.channel) {
            supabaseClient.removeChannel(this.channel);
            this.channel = null;
        }

        this.isSubscribed = false;
        this.eventQueue = [];
        this.isProcessing = false;
    }
}

// 创建全局实例
let realtimeManager = null;

/**
 * 初始化实时订阅
 */
function initRealtimeSubscription() {
    if (!supabaseClient) {
        return false;
    }

    if (!realtimeManager) {
        realtimeManager = new RealtimeSubscriptionManager();
    }

    return realtimeManager.subscribe();
}

/**
 * 停止实时订阅
 */
function stopRealtimeSubscription() {
    if (realtimeManager) {
        realtimeManager.unsubscribe();
    }
}

// 暴露到全局作用域
if (typeof window !== 'undefined') {
    window.initRealtimeSubscription = initRealtimeSubscription;
    window.stopRealtimeSubscription = stopRealtimeSubscription;
    window.realtimeManager = realtimeManager;
}

