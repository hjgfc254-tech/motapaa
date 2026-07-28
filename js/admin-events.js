/* ===========================
   SCHOOLHUB PRO - ADMIN EVENTS MANAGER
   مدارس الجيل الجديد الخاصة
   الإصدار: 2.0
   =========================== */

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
  showConfirm 
} from './utils.js';

import { cacheManager, CACHE_CONFIG } from './cache-manager.js';

class AdminEventsManager {
  constructor() {
    this.lastVisible = null;
    this.hasMore = false;
    this.currentFilter = 'all';
  }

  async getEvents(options = {}) {
    const loadMore = options.loadMore || false;
    const limitCount = options.limit || 20;

    try {
      const queryOptions = {
        orderByField: 'event_date',
        orderDirection: 'desc',
        limitCount: limitCount
      };

      if (loadMore && this.lastVisible) {
        queryOptions.startAfterDoc = this.lastVisible;
      }

      if (this.currentFilter !== 'all') {
        queryOptions.filters = [['type', '==', this.currentFilter]];
      }

      const result = await fetchDocuments('events', queryOptions);
      
      this.lastVisible = result.lastVisible;
      this.hasMore = result.hasMore && (result.documents || []).length === limitCount;

      return {
        events: result.documents || [],
        hasMore: this.hasMore
      };

    } catch (error) {
      console.error('❌ فشل جلب الأحداث:', error.message);
      throw error;
    }
  }

  async getEvent(eventId) {
    try {
      return await fetchDocument('events', eventId);
    } catch (error) {
      console.error('❌ فشل جلب الحدث:', error.message);
      throw error;
    }
  }

  async createEvent(data) {
    try {
      if (!data.title || !data.title.trim()) {
        throw new Error('اسم الحدث مطلوب');
      }
      if (!data.event_date) {
        throw new Error('تاريخ الحدث مطلوب');
      }

      const event = {
        title: data.title.trim(),
        description: data.description || '',
        type: data.type || 'activity',
        event_date: data.event_date,
        images: data.images || [],
        target: data.target || 'all',
        target_ids: data.target_ids || [],
        target_labels: data.target_labels || [],
        created_by: data.created_by || 'الإدارة',
        createdAt: getServerTimestamp(),
        updatedAt: getServerTimestamp()
      };

      const eventId = await saveDocument('events', null, event, false);

      try {
        await incrementField('counters', 'stats', 'total_events', 1);
      } catch (e) {}

      cacheManager.invalidate(CACHE_CONFIG.keys.public_events);
      cacheManager.invalidateAdminCache();

      showToast('تم إضافة الحدث بنجاح 🎉', 'success');
      return eventId;

    } catch (error) {
      showToast(error.message || 'فشل إضافة الحدث', 'error');
      throw error;
    }
  }

  async updateEvent(eventId, data) {
    try {
      await updateDocument('events', eventId, {
        ...data,
        updatedAt: getServerTimestamp()
      });

      cacheManager.invalidate(CACHE_CONFIG.keys.public_events);
      cacheManager.invalidateAdminCache();
      showToast('تم تحديث الحدث ✅', 'success');

    } catch (error) {
      showToast('فشل تحديث الحدث', 'error');
      throw error;
    }
  }

  async deleteEvent(eventId) {
    try {
      const event = await this.getEvent(eventId);
      if (!event) throw new Error('الحدث غير موجود');

      const confirmed = await showConfirm(
        `هل أنت متأكد من حذف حدث "${event.title}"؟`,
        'تأكيد الحذف',
        'نعم، احذف',
        'إلغاء'
      );

      if (!confirmed) return;

      await removeDocument('events', eventId);

      try {
        await incrementField('counters', 'stats', 'total_events', -1);
      } catch (e) {}

      cacheManager.invalidate(CACHE_CONFIG.keys.public_events);
      cacheManager.invalidateAdminCache();
      showToast('تم حذف الحدث 🗑️', 'success');

    } catch (error) {
      showToast(error.message || 'فشل حذف الحدث', 'error');
      throw error;
    }
  }

  resetFilters() {
    this.currentFilter = 'all';
    this.lastVisible = null;
    this.hasMore = false;
  }
}

const adminEvents = new AdminEventsManager();

export { AdminEventsManager, adminEvents };

console.log('📦 Admin Events Manager: جاهز');