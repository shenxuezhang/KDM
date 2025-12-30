/**
 * 图片上传模块
 * 提供截图超链接工具功能，支持批量上传图片到GitHub并获取直链
 */

// ============================================
// 配置常量
// ============================================
const MAX_FILE_SIZE = 2 * 1024 * 1024; // 2MB

// ============================================
// 工具函数
// ============================================

/**
 * 将文件转换为Base64编码
 * @param {File} file - 要转换的文件
 * @returns {Promise<string>} Base64编码的字符串
 */
function toBase64(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.readAsDataURL(file);
        reader.onload = () => resolve(reader.result);
        reader.onerror = error => reject(error);
    });
}

/**
 * 压缩图片
 * @param {File} file - 要压缩的图片文件
 * @param {number} maxSize - 最大文件大小（字节），默认2MB
 * @param {number} quality - 压缩质量（0-1），默认0.8
 * @returns {Promise<File>} 压缩后的文件
 */
function compressImage(file, maxSize = MAX_FILE_SIZE, quality = 0.8) {
    return new Promise((resolve, reject) => {
        // 如果文件已经小于限制，直接返回
        if (file.size <= maxSize) {
            resolve(file);
            return;
        }

        const reader = new FileReader();
        reader.readAsDataURL(file);
        
        reader.onload = (e) => {
            const img = new Image();
            img.src = e.target.result;
            
            img.onload = () => {
                const canvas = document.createElement('canvas');
                let width = img.width;
                let height = img.height;
                
                // 计算压缩后的尺寸（保持宽高比）
                const maxDimension = 1920; // 最大尺寸
                if (width > maxDimension || height > maxDimension) {
                    if (width > height) {
                        height = (height / width) * maxDimension;
                        width = maxDimension;
                    } else {
                        width = (width / height) * maxDimension;
                        height = maxDimension;
                    }
                }
                
                canvas.width = width;
                canvas.height = height;
                
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0, width, height);
                
                // 尝试不同的质量值，直到文件大小符合要求
                let currentQuality = quality;
                let attempts = 0;
                const maxAttempts = 5;
                
                const tryCompress = () => {
                    canvas.toBlob((blob) => {
                        if (!blob) {
                            reject(new Error('图片压缩失败'));
                            return;
                        }
                        
                        // 如果文件大小符合要求，或者已经尝试多次，返回结果
                        if (blob.size <= maxSize || attempts >= maxAttempts) {
                            if (blob.size > maxSize) {
                                // 压缩后仍然过大
                                reject(new Error('文件过大，压缩不成功请进行人工处理再上传'));
                            } else {
                                // 创建新的File对象
                                const compressedFile = new File([blob], file.name, {
                                    type: file.type,
                                    lastModified: Date.now()
                                });
                                resolve(compressedFile);
                            }
                        } else {
                            // 继续降低质量
                            attempts++;
                            currentQuality = Math.max(0.1, currentQuality - 0.1);
                            canvas.toBlob(tryCompress, file.type, currentQuality);
                        }
                    }, file.type, currentQuality);
                };
                
                tryCompress();
            };
            
            img.onerror = () => {
                reject(new Error('图片加载失败'));
            };
        };
        
        reader.onerror = () => {
            reject(new Error('文件读取失败'));
        };
    });
}

/**
 * 更新文件选择提示信息
 */
function updateImageFileLabel() {
    const fileInput = document.getElementById('imageFileInput');
    const info = document.getElementById('imageFileInfo');
    if (!fileInput || !info) return;
    
    const count = fileInput.files.length;
    if (count > 0) {
        info.innerHTML = `已选择 <b>${count}</b> 个文件`;
        info.className = 'text-xs text-emerald-600 dark:text-emerald-400 mt-1.5';
    } else {
        info.innerHTML = "未选择文件";
        info.className = 'text-xs text-slate-400 dark:text-slate-500 mt-1.5';
    }
}

/**
 * 将文件添加到文件输入框
 * @param {FileList|File[]} files - 要添加的文件列表
 */
function addFilesToInput(files) {
    const fileInput = document.getElementById('imageFileInput');
    if (!fileInput) return;
    
    const dataTransfer = new DataTransfer();
    
    // 保留现有文件
    for (let i = 0; i < fileInput.files.length; i++) {
        dataTransfer.items.add(fileInput.files[i]);
    }
    
    // 添加新文件
    for (let i = 0; i < files.length; i++) {
        const file = files[i];
        // 只添加图片文件
        if (file.type.startsWith('image/')) {
            dataTransfer.items.add(file);
        }
    }
    
    fileInput.files = dataTransfer.files;
    updateImageFileLabel();
}

/**
 * 处理粘贴事件
 * @param {ClipboardEvent} e - 粘贴事件
 */
function handleImagePaste(e) {
    const items = e.clipboardData?.items;
    if (!items) return;
    
    const imageFiles = [];
    for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (item.type.indexOf('image') !== -1) {
            const file = item.getAsFile();
            if (file) {
                imageFiles.push(file);
            }
        }
    }
    
    if (imageFiles.length > 0) {
        e.preventDefault();
        addFilesToInput(imageFiles);
        if (typeof showToast === 'function') {
            showToast(`已粘贴 ${imageFiles.length} 张图片`, 'success');
        }
    }
}

// ============================================
// 上传功能
// ============================================

/**
 * 批量上传图片到GitHub
 */
async function uploadImagesToGitHub() {
    const fileInput = document.getElementById('imageFileInput');
    const statusDiv = document.getElementById('imageUploadStatus');
    const resultTextarea = document.getElementById('imageResultLink');
    const uploadBtn = document.getElementById('imageUploadBtn');

    if (!fileInput || !statusDiv || !resultTextarea || !uploadBtn) {
        if (typeof showToast === 'function') {
            showToast('图片上传模块未正确初始化', 'error');
        }
        return;
    }

    const files = fileInput.files;
    if (files.length === 0) {
        if (typeof showToast === 'function') {
            showToast('请先选择图片文件', 'error');
        }
        return;
    }

    // 检查配置
    const config = window.GITHUB_UPLOAD_CONFIG || {};
    if (!config.token) {
        if (typeof showToast === 'function') {
            showToast('请先在配置中设置GitHub Token', 'error');
        }
        return;
    }

    uploadBtn.disabled = true;
    const originalBtnText = uploadBtn.innerHTML;
    uploadBtn.innerHTML = '<span class="animate-spin mr-2">⏳</span>处理中...';

    resultTextarea.value = "";
    statusDiv.innerHTML = "";

    let successCount = 0;
    let failCount = 0;

    for (let i = 0; i < files.length; i++) {
        const file = files[i];

        // 更新状态
        statusDiv.innerHTML += `<div class="text-sm text-slate-600 dark:text-slate-400 mb-1">准备处理: ${file.name}...</div>`;

        let fileToUpload = file;
        let needCompress = false;

        // 检测文件大小，大于2MB则压缩
        if (file.size > MAX_FILE_SIZE) {
            statusDiv.lastElementChild.innerHTML = `<div class="text-sm text-slate-600 dark:text-slate-400 mb-1">${file.name} 超过2MB，正在压缩...</div>`;
            needCompress = true;
            
            try {
                fileToUpload = await compressImage(file);
                statusDiv.lastElementChild.innerHTML = `<div class="text-sm text-emerald-600 dark:text-emerald-400 mb-1">${file.name} 压缩成功 (${(file.size / 1024 / 1024).toFixed(2)}MB → ${(fileToUpload.size / 1024 / 1024).toFixed(2)}MB)</div>`;
            } catch (compressError) {
                console.error('压缩失败:', compressError);
                statusDiv.lastElementChild.innerHTML = `<span class="text-red-600 dark:text-red-400 font-semibold">✘ ${file.name} 失败: ${compressError.message}</span>`;
                
                // 弹窗提示
                if (typeof showToast === 'function') {
                    showToast(`${file.name}: 文件过大，压缩不成功请进行人工处理再上传`, 'error');
                } else {
                    alert(`${file.name}: 文件过大，压缩不成功请进行人工处理再上传`);
                }
                
                failCount++;
                continue;
            }
        }

        try {
            const base64Content = await toBase64(fileToUpload);
            const content = base64Content.split(',')[1];
            const timestamp = new Date().getTime();
            const fileName = `${timestamp}_${i}_${file.name.replace(/\s+/g, '_')}`;
            const path = `${config.folder}/${fileName}`;
            const url = `https://api.github.com/repos/${config.username}/${config.repo}/contents/${encodeURIComponent(path)}`;

            const response = await fetch(url, {
                method: 'PUT',
                headers: {
                    'Authorization': `token ${config.token}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    message: `Batch Upload ${fileName}`,
                    content: content
                })
            });

            const data = await response.json();

            if (response.ok) {
                resultTextarea.value += data.content.download_url + "\n";
                const compressInfo = needCompress ? ' (已压缩)' : '';
                statusDiv.lastElementChild.innerHTML = `<span class="text-emerald-600 dark:text-emerald-400 font-semibold">✔ ${file.name} 上传成功${compressInfo}</span>`;
                successCount++;
            } else {
                throw new Error(data.message || "未知错误");
            }

        } catch (error) {
            console.error('上传失败:', error);
            statusDiv.lastElementChild.innerHTML = `<span class="text-red-600 dark:text-red-400 font-semibold">✘ ${file.name} 失败: ${error.message}</span>`;
            failCount++;
        }
    }

    uploadBtn.disabled = false;
    uploadBtn.innerHTML = originalBtnText;
    statusDiv.innerHTML += `<hr class="my-2 border-slate-200 dark:border-slate-700"><p class="text-sm font-semibold text-slate-700 dark:text-slate-300"><b>处理完成！成功: ${successCount}，失败: ${failCount}</b></p>`;

    if (successCount > 0 && typeof showToast === 'function') {
        showToast(`成功上传 ${successCount} 张图片`, 'success');
    }
}

/**
 * 一键填入到附件清单
 */
function fillImageLinksToAttachments() {
    const textarea = document.getElementById('imageResultLink');
    const attachmentsInput = document.getElementById('attachments');

    if (!textarea || !attachmentsInput) {
        if (typeof showToast === 'function') {
            showToast('未找到附件清单输入框', 'error');
        }
        return;
    }

    const links = textarea.value.trim();
    if (!links) {
        if (typeof showToast === 'function') {
            showToast('没有可填入的链接', 'error');
        }
        return;
    }

    // 将多行链接直接填入（保持换行格式，因为附件清单已改为textarea）
    attachmentsInput.value = links;

    if (typeof showToast === 'function') {
        showToast(`已填入 ${linkArray.length} 个链接到附件清单`, 'success');
    }

    // 标记表单为已修改
    if (typeof markFormDirty === 'function') {
        markFormDirty();
    }
}

// ============================================
// 重置函数
// ============================================

/**
 * 重置图片上传模块
 * 只针对截图超链接工具模块，清空所有文件选择、状态信息和结果显示
 * 注意：不会影响附件清单输入框（id="attachments"）的内容
 * @param {Event} event - 可选的事件对象，用于阻止事件冒泡和默认行为
 */
function resetImageUpload(event) {
    // 阻止事件冒泡和默认行为，防止触发表单提交
    if (event) {
        event.preventDefault();
        event.stopPropagation();
    }
    
    const fileInput = document.getElementById('imageFileInput');
    const info = document.getElementById('imageFileInfo');
    const statusDiv = document.getElementById('imageUploadStatus');
    const resultTextarea = document.getElementById('imageResultLink');
    const uploadBtn = document.getElementById('imageUploadBtn');
    
    // 清空文件输入框
    if (fileInput) {
        fileInput.value = '';
    }
    
    // 重置文件信息提示
    if (info) {
        info.innerHTML = "未选择文件";
        info.className = 'text-xs text-slate-400 dark:text-slate-500 mt-1.5';
    }
    
    // 清空上传状态显示
    if (statusDiv) {
        statusDiv.innerHTML = '';
    }
    
    // 清空结果显示
    if (resultTextarea) {
        resultTextarea.value = '';
    }
    
    // 恢复上传按钮状态
    if (uploadBtn) {
        uploadBtn.disabled = false;
        uploadBtn.classList.remove('opacity-50', 'cursor-not-allowed');
    }
    
    if (typeof showToast === 'function') {
        showToast('已重置', 'success');
    }
    
    // 返回 false 进一步防止默认行为
    return false;
}

// ============================================
// 初始化函数
// ============================================

/**
 * 初始化图片上传模块
 */
function initImageUploadModule() {
    const fileInput = document.getElementById('imageFileInput');
    const dropZone = document.getElementById('imageDropZone');
    
    if (fileInput) {
        fileInput.addEventListener('change', updateImageFileLabel);
    }
    
    // 粘贴功能
    document.addEventListener('paste', handleImagePaste);
    
    // 拖拽功能
    if (dropZone) {
        // 阻止默认拖拽行为
        ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
            dropZone.addEventListener(eventName, (e) => {
                e.preventDefault();
                e.stopPropagation();
            }, false);
        });
        
        // 拖拽进入
        dropZone.addEventListener('dragenter', () => {
            dropZone.classList.add('border-blue-500', 'dark:border-blue-400', 'bg-blue-100', 'dark:bg-blue-900/30');
        });
        
        // 拖拽离开
        dropZone.addEventListener('dragleave', () => {
            dropZone.classList.remove('border-blue-500', 'dark:border-blue-400', 'bg-blue-100', 'dark:bg-blue-900/30');
        });
        
        // 放置文件
        dropZone.addEventListener('drop', (e) => {
            dropZone.classList.remove('border-blue-500', 'dark:border-blue-400', 'bg-blue-100', 'dark:bg-blue-900/30');
            
            const files = e.dataTransfer.files;
            if (files.length > 0) {
                addFilesToInput(files);
                if (typeof showToast === 'function') {
                    showToast(`已添加 ${files.length} 个文件`, 'success');
                }
            }
        });
        
        // 点击拖拽区域显示粘贴提示
        dropZone.addEventListener('click', () => {
            alert('请按确定之后 Ctrl+V 进行粘贴操作。');
        });
    }
}

// 暴露到全局作用域
if (typeof window !== 'undefined') {
    window.uploadImagesToGitHub = uploadImagesToGitHub;
    window.fillImageLinksToAttachments = fillImageLinksToAttachments;
    window.updateImageFileLabel = updateImageFileLabel;
    window.resetImageUpload = resetImageUpload;
    window.initImageUploadModule = initImageUploadModule;
}

