/* ===========================
   SCHOOLHUB PRO - ADMIN MESSAGES MANAGER
   مدارس الجيل الجديد الخاصة
   الإصدار: 2.0
   =========================== */

/**
 * وحدة إدارة الرسائل للوحة تحكم الإدارة
 * توفر دوال كاملة لإدارة الرسائل: قراءة، إرسال، رد، حذف
 */

import { 
  fetchDocument, 
  fetchDocuments, 
  saveDocument, 
  updateDocument, 
  removeDocument, 
  incrementField,
  getServerTimestamp
} from './firebase-config.js';

import { 
  showToast, 
  showConfirm, 
  formatDateArabic,
  timeAgoArabic
} from './utils.js';

import { cacheManager, CACHE_CONFIG } from './cache-manager.js';

// ===========================
// ثوابت
// ===========================
const MESSAGES_PER_PAGE = 20;

// ===========================
// كلاس إدارة الرسائل
// ===========================
class AdminMessagesManager {
  constructor() {
    this.currentFilters = {
      type: 'all',
      status: 'all',
      search: ''
    };
    this.lastVisible = null;
    this.hasMore = false;
    this.isLoading = false;
    this.listeners = [];
  }

  /**
   * جلب قائمة الرسائل
   * @param {Object} options
   * @returns {Promise<Object>}
   */
  async getMessages(options = {}) {
    const loadMore = options.loadMore || false;
    const limitCount = options.limit || MESSAGES_PER_PAGE;

    try {
      this.isLoading = true;
      this.notifyListeners('loading', true);

      const queryFilters = [];

      // فلترة حسب النوع
      if (this.currentFilters.type === 'incoming') {
        queryFilters.push(['type', '==', 'student_to_school']);
      } else if (this.currentFilters.type === 'sent') {
        queryFilters.push(['type', '==', 'school_to_student']);
      }

      // فلترة حسب حالة القراءة
      if (this.currentFilters.status === 'unread') {
        queryFilters.push(['read', '==', false]);
      } else if (this.currentFilters.status === 'replied') {
        queryFilters.push(['reply', '!=', null]);
      }

      const queryOptions = {
        filters: queryFilters,
        orderByField: 'createdAt',
        orderDirection: 'desc',
        limitCount: limitCount
      };

      if (loadMore && this.lastVisible) {
        queryOptions.startAfterDoc = this.lastVisible;
      }

      const result = await fetchDocuments('messages', queryOptions);

      let messages = result.documents || [];

      // فلترة بالبحث
      if (this.currentFilters.search) {
        const searchTerm = this.currentFilters.search.toLowerCase();
        messages = messages.filter(m => {
          return (
            (m.subject && m.subject.toLowerCase().includes(searchTerm)) ||
            (m.body && m.body.toLowerCase().includes(searchTerm)) ||
            (m.from_name && m.from_name.toLowerCase().includes(searchTerm))
          );
        });
      }

      this.lastVisible = result.lastVisible;
      this.hasMore = result.hasMore && messages.length === limitCount;
      this.isLoading = false;

      this.notifyListeners('loaded', { messages, hasMore: this.hasMore });

      return {
        messages,
        hasMore: this.hasMore,
        total: messages.length
      };

    } catch (error) {
      this.isLoading = false;
      this.notifyListeners('error', error);
      console.error('❌ فشل جلب الرسائل:', error.message);
      throw error;
    }
  }

  /**
   * جلب رسالة واحدة
   * @param {string} messageId
   * @returns {Promise<Object|null>}
   */
  async getMessage(messageId) {
    try {
      const message = await fetchDocument('messages', messageId);
      
      // تحديث حالة القراءة إذا كانت الرسالة من طالب ولم تقرأ بعد
      if (message && message.type === 'student_to_school' && !message.read) {
        await updateDocument('messages', messageId, {
          read: true,
          updatedAt: getServerTimestamp()
        });
        cacheManager.invalidate(CACHE_CONFIG.keys.student_messages);
      }
      
      return message;
    } catch (error) {
      console.error('❌ فشل جلب الرسالة:', error.message);
      throw error;
    }
  }

  /**
   * إرسال رسالة من الإدارة
   * @param {Object} data - بيانات الرسالة
   * @returns {Promise<string>}
   */
  async sendMessage(data) {
    try {
      this.validateMessageData(data);

      const message = {
        type: 'school_to_student',
        from: 'admin',
        from_name: data.from_name || 'الإدارة',
        to: data.to,
        to_name: data.to_name || '',
        subject: data.subject.trim(),
        body: data.body.trim(),
        read: false,
        reply: null,
        createdAt: getServerTimestamp(),
        updatedAt: getServerTimestamp()
      };

      const messageId = await saveDocument('messages', null, message, false);

      // تحديث العداد
      try {
        await incrementField('counters', 'stats', 'total_messages', 1);
      } catch (counterError) {
        console.warn('⚠️ فشل تحديث العداد');
      }

      cacheManager.invalidate(CACHE_CONFIG.keys.student_messages);
      cacheManager.invalidateAdminCache();

      showToast('تم إرسال الرسالة بنجاح 📨', 'success');

      return messageId;

    } catch (error) {
      showToast(error.message || 'فشل إرسال الرسالة', 'error');
      throw error;
    }
  }

  /**
   * الرد على رسالة طالب
   * @param {string} messageId - معرف الرسالة الأصلية
   * @param {string} replyBody - نص الرد
   * @returns {Promise<void>}
   */
  async replyToMessage(messageId, replyBody) {
    try {
      if (!replyBody || !replyBody.trim()) {
        throw new Error('نص الرد مطلوب');
      }

      const originalMessage = await fetchDocument('messages', messageId);
      
      if (!originalMessage) {
        throw new Error('الرسالة غير موجودة');
      }

      await updateDocument('messages', messageId, {
        reply: replyBody.trim(),
        read: true,
        updatedAt: getServerTimestamp()
      });

      cacheManager.invalidate(CACHE_CONFIG.keys.student_messages);
      cacheManager.invalidateAdminCache();

      showToast('تم إرسال الرد بنجاح ✅', 'success');

    } catch (error) {
      showToast(error.message || 'فشل إرسال الرد', 'error');
      throw error;
    }
  }

  /**
   * إرسال رسالة لطالب محدد
   * @param {string} studentId
   * @param {string} studentName
   * @param {string} subject
   * @param {string} body
   * @returns {Promise<string>}
   */
  async sendMessageToStudent(studentId, studentName, subject, body) {
    return await this.sendMessage({
      to: studentId,
      to_name: studentName,
      subject: subject,
      body: body
    });
  }

  /**
   * إرسال رسالة جماعية لمرحلة
   * @param {Array<string>} studentIds
   * @param {string} subject
   * @param {string} body
   * @returns {Promise<Object>}
   */
  async sendBulkMessage(studentIds, subject, body) {
    try {
      if (!studentIds || studentIds.length === 0) {
        throw new Error('لم يتم تحديد طلاب للإرسال');
      }

      const results = {
        success: [],
        failed: [],
        total: studentIds.length
      };

      for (const studentId of studentIds) {
        try {
          const messageId = await this.sendMessageToStudent(
            studentId,
            '',
            subject,
            body
          );
          results.success.push({ studentId, messageId });
        } catch (error) {
          results.failed.push({ studentId, error: error.message });
        }
      }

      showToast(
        `تم الإرسال إلى ${results.success.length} طالب` + 
        (results.failed.length > 0 ? ` (فشل: ${results.failed.length})` : ''),
        results.failed.length === 0 ? 'success' : 'warning'
      );

      return results;

    } catch (error) {
      showToast(error.message || 'فشل الإرسال الجماعي', 'error');
      throw error;
    }
  }

  /**
   * حذف رسالة
   * @param {string} messageId
   * @returns {Promise<void>}
   */
  async deleteMessage(messageId) {
    try {
      const confirmed = await showConfirm(
        'هل أنت متأكد من حذف هذه الرسالة؟',
        'تأكيد الحذف',
        'نعم، احذف',
        'إلغاء'
      );

      if (!confirmed) return;

      await removeDocument('messages', messageId);

      cacheManager.invalidate(CACHE_CONFIG.keys.student_messages);
      cacheManager.invalidateAdminCache();

      showToast('تم حذف الرسالة بنجاح 🗑️', 'success');

    } catch (error) {
      showToast(error.message || 'فشل حذف الرسالة', 'error');
      throw error;
    }
  }

  /**
   * حذف رسائل متعددة
   * @param {Array<string>} messageIds
   * @returns {Promise<number>}
   */
  async deleteMultipleMessages(messageIds) {
    try {
      const confirmed = await showConfirm(
        `هل أنت متأكد من حذف ${messageIds.length} رسالة؟`,
        'تأكيد الحذف الجماعي',
        'نعم، احذف الكل',
        'إلغاء'
      );

      if (!confirmed) return 0;

      let deletedCount = 0;
      for (const id of messageIds) {
        try {
          await removeDocument('messages', id);
          deletedCount++;
        } catch (error) {
          console.warn(`⚠️ فشل حذف الرسالة ${id}:`, error.message);
        }
      }

      cacheManager.invalidate(CACHE_CONFIG.keys.student_messages);
      cacheManager.invalidateAdminCache();

      showToast(`تم حذف ${deletedCount} رسالة بنجاح 🗑️`, 'success');

      return deletedCount;

    } catch (error) {
      showToast(error.message || 'فشل الحذف الجماعي', 'error');
      throw error;
    }
  }

  /**
   * الحصول على إحصائيات الرسائل
   * @returns {Promise<Object>}
   */
  async getMessageStats() {
    try {
      const [unreadResult, repliedResult, totalResult] = await Promise.all([
        fetchDocuments('messages', { 
          filters: [['type', '==', 'student_to_school'], ['read', '==', false]], 
          limitCount: 1 
        }),
        fetchDocuments('messages', { 
          filters: [['reply', '!=', null]], 
          limitCount: 1 
        }),
        fetchDocuments('messages', { limitCount: 1 })
      ]);

      return {
        unread: unreadResult.documents?.length || 0,
        replied: repliedResult.documents?.length || 0,
        total: totalResult.documents?.length || 0
      };
    } catch (error) {
      console.error('❌ فشل جلب إحصائيات الرسائل:', error.message);
      return { unread: 0, replied: 0, total: 0 };
    }
  }

  /**
   * جلب محادثة كاملة مع طالب
   * @param {string} studentId
   * @returns {Promise<Array>}
   */
  async getConversationWithStudent(studentId) {
    try {
      const result = await fetchDocuments('messages', {
        filters: [
          ['from', '==', studentId]
        ],
        orderByField: 'createdAt',
        orderDirection: 'asc',
        limitCount: 50
      });

      const sentResult = await fetchDocuments('messages', {
        filters: [
          ['to', '==', studentId]
        ],
        orderByField: 'createdAt',
        orderDirection: 'asc',
        limitCount: 50
      });

      const allMessages = [
        ...(result.documents || []),
        ...(sentResult.documents || [])
      ];

      // ترتيب حسب التاريخ
      allMessages.sort((a, b) => {
        const dateA = a.createdAt?.toDate ? a.createdAt.toDate() : new Date(a.createdAt);
        const dateB = b.createdAt?.toDate ? b.createdAt.toDate() : new Date(b.createdAt);
        return dateA - dateB;
      });

      return allMessages;

    } catch (error) {
      console.error('❌ فشل جلب المحادثة:', error.message);
      throw error;
    }
  }

  /**
   * التحقق من صحة بيانات الرسالة
   * @param {Object} data
   */
  validateMessageData(data) {
    if (!data.to) {
      throw new Error('المستقبل مطلوب');
    }

    if (!data.subject || !data.subject.trim()) {
      throw new Error('موضوع الرسالة مطلوب');
    }

    if (!data.body || !data.body.trim()) {
      throw new Error('نص الرسالة مطلوب');
    }

    if (data.subject.length > 100) {
      throw new Error('موضوع الرسالة يجب ألا يتجاوز 100 حرف');
    }

    if (data.body.length > 2000) {
      throw new Error('نص الرسالة يجب ألا يتجاوز 2000 حرف');
    }
  }

  /**
   * إعادة تعيين الفلاتر
   */
  resetFilters() {
    this.currentFilters = {
      type: 'all',
      status: 'all',
      search: ''
    };
    this.lastVisible = null;
    this.hasMore = false;
  }

  /**
   * إضافة مستمع
   */
  addListener(listener) {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter(l => l !== listener);
    };
  }

  /**
   * إعلام المستمعين
   */
  notifyListeners(event, data) {
    this.listeners.forEach(listener => {
      try { listener(event, data); } catch (error) {
        console.error('❌ خطأ في مستمع:', error.message);
      }
    });
  }
}

// ===========================
// نسخة واحدة
// ===========================
const adminMessages = new AdminMessagesManager();

// ===========================
// تصدير
// ===========================
export {
  AdminMessagesManager,
  adminMessages,
  MESSAGES_PER_PAGE
};

console.log('📦 Admin Messages Manager: جاهز');