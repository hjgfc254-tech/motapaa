/* ===========================
   SCHOOLHUB PRO - ADMIN SETTINGS MANAGER
   مدارس الجيل الجديد الخاصة
   الإصدار: 2.1 (مُصحح)
   =========================== */

/**
 * وحدة إدارة إعدادات النظام للوحة تحكم الإدارة
 * توفر دوال للتحكم في الإعدادات العامة ووضع الصيانة والمشرفين
 * 
 * الإصلاحات في هذا الإصدار:
 * - #1: منع حذف آخر مشرف في النظام
 * - إضافة: منع تعطيل آخر مشرف نشط
 * - إضافة: منع تغيير دور آخر مشرف إلى غير نشط
 */

import { 
  fetchDocument, 
  fetchDocuments, 
  saveDocument, 
  updateDocument, 
  removeDocument, 
  getServerTimestamp,
  incrementField
} from './firebase-config.js';

import { 
  hashPassword, 
  generateSecurePassword,
  showToast, 
  showConfirm, 
  showAlert 
} from './utils.js';

import { cacheManager, CACHE_CONFIG } from './cache-manager.js';

// ===========================
// كلاس إدارة الإعدادات
// ===========================
class AdminSettingsManager {
  constructor() {
    this.currentSettings = null;
  }

  /**
   * جلب الإعدادات الحالية
   * @returns {Promise<Object>}
   */
  async getSettings() {
    try {
      const settings = await fetchDocument('settings', 'general');
      this.currentSettings = settings;
      return settings;
    } catch (error) {
      console.error('❌ فشل جلب الإعدادات:', error.message);
      throw error;
    }
  }

  /**
   * تحديث الإعدادات العامة
   * @param {Object} newSettings - الإعدادات الجديدة
   * @returns {Promise<void>}
   */
  async updateSettings(newSettings) {
    try {
      const allowedFields = [
        'school_name',
        'school_name_short',
        'school_motto',
        'logo_url',
        'current_academic_year',
        'current_term',
        'inactive_student_message',
        'maintenance_message',
        'max_students_per_class',
        'default_language',
        'timezone',
        'working_hours_start',
        'working_hours_end'
      ];

      // تصفية الحقول المسموح بها فقط
      const filteredSettings = {};
      for (const field of allowedFields) {
        if (newSettings[field] !== undefined) {
          filteredSettings[field] = newSettings[field];
        }
      }

      await updateDocument('settings', 'general', {
        ...filteredSettings,
        updatedAt: getServerTimestamp()
      });

      // مسح الكاش
      cacheManager.invalidate(CACHE_CONFIG.keys.admin_settings);
      cacheManager.invalidateAdminCache();

      this.currentSettings = { ...this.currentSettings, ...filteredSettings };

      showToast('تم تحديث الإعدادات بنجاح ✅', 'success');

    } catch (error) {
      showToast(error.message || 'فشل تحديث الإعدادات', 'error');
      throw error;
    }
  }

  /**
   * تفعيل/إيقاف وضع الصيانة
   * @returns {Promise<boolean>} الحالة الجديدة
   */
  async toggleMaintenanceMode() {
    try {
      const settings = await this.getSettings();
      const currentMode = settings?.maintenance_mode || false;
      const newMode = !currentMode;

      const confirmed = await showConfirm(
        newMode 
          ? 'سيتم تفعيل وضع الصيانة. لن يتمكن الطلاب من تسجيل الدخول. هل تريد المتابعة؟'
          : 'سيتم إيقاف وضع الصيانة. سيتمكن الطلاب من تسجيل الدخول مرة أخرى. هل تريد المتابعة؟',
        newMode ? 'تفعيل الصيانة' : 'إيقاف الصيانة',
        'نعم',
        'إلغاء'
      );

      if (!confirmed) return currentMode;

      await updateDocument('settings', 'general', {
        maintenance_mode: newMode,
        updatedAt: getServerTimestamp()
      });

      // تسجيل العملية
      await saveDocument('system_logs', null, {
        action: newMode ? 'maintenance_on' : 'maintenance_off',
        details: newMode ? 'تم تفعيل وضع الصيانة' : 'تم إيقاف وضع الصيانة',
        performed_by: 'admin',
        timestamp: getServerTimestamp()
      }, false);

      cacheManager.invalidate(CACHE_CONFIG.keys.admin_settings);
      cacheManager.invalidateAdminCache();

      showToast(
        newMode ? '🔴 تم تفعيل وضع الصيانة' : '🟢 تم إيقاف وضع الصيانة',
        newMode ? 'warning' : 'success'
      );

      return newMode;

    } catch (error) {
      showToast('فشل تغيير وضع الصيانة', 'error');
      throw error;
    }
  }

  /**
   * تحديث رسالة الحساب غير المفعل
   * @param {string} message 
   * @returns {Promise<void>}
   */
  async updateInactiveMessage(message) {
    try {
      if (!message || !message.trim()) {
        throw new Error('الرسالة مطلوبة');
      }

      await updateDocument('settings', 'general', {
        inactive_student_message: message.trim(),
        updatedAt: getServerTimestamp()
      });

      cacheManager.invalidate(CACHE_CONFIG.keys.admin_settings);
      showToast('تم تحديث رسالة الحساب غير المفعل ✅', 'success');

    } catch (error) {
      showToast(error.message || 'فشل تحديث الرسالة', 'error');
      throw error;
    }
  }

  /**
   * تحديث رسالة الصيانة
   * @param {string} message 
   * @returns {Promise<void>}
   */
  async updateMaintenanceMessage(message) {
    try {
      if (!message || !message.trim()) {
        throw new Error('الرسالة مطلوبة');
      }

      await updateDocument('settings', 'general', {
        maintenance_message: message.trim(),
        updatedAt: getServerTimestamp()
      });

      cacheManager.invalidate(CACHE_CONFIG.keys.admin_settings);
      showToast('تم تحديث رسالة الصيانة ✅', 'success');

    } catch (error) {
      showToast(error.message || 'فشل تحديث الرسالة', 'error');
      throw error;
    }
  }

  // ===========================
  // إدارة المشرفين
  // ===========================

  /**
   * جلب عدد المشرفين النشطين
   * @returns {Promise<number>}
   */
  async getActiveAdminsCount() {
    try {
      const result = await fetchDocuments('admins', {
        filters: [['is_active', '==', true]],
        limitCount: 50
      });
      return (result.documents || []).length;
    } catch (error) {
      console.error('❌ فشل جلب عدد المشرفين:', error.message);
      return 0;
    }
  }

  /**
   * جلب العدد الإجمالي للمشرفين
   * @returns {Promise<number>}
   */
  async getTotalAdminsCount() {
    try {
      const result = await fetchDocuments('admins', {
        limitCount: 50
      });
      return (result.documents || []).length;
    } catch (error) {
      console.error('❌ فشل جلب عدد المشرفين:', error.message);
      return 0;
    }
  }

  /**
   * التحقق من أن المشرف ليس آخر مشرف في النظام
   * @param {string} adminId - معرف المشرف (اختياري، للحذف/التعطيل)
   * @param {string} action - نوع العملية ('delete', 'deactivate', 'change_role')
   * @returns {Promise<boolean>} هل العملية مسموحة
   */
  async canModifyAdmin(adminId = null, action = 'delete') {
    try {
      if (action === 'delete') {
        // لا يمكن حذف المشرف إذا كان هو الوحيد
        const totalCount = await this.getTotalAdminsCount();
        if (totalCount <= 1) {
          return { 
            allowed: false, 
            message: 'لا يمكن حذف المشرف الوحيد في النظام. يجب وجود مشرف واحد على الأقل.' 
          };
        }
        
        // لا يمكن حذف المشرف إذا كان آخر مشرف نشط
        if (adminId) {
          const admin = await fetchDocument('admins', adminId);
          if (admin && admin.is_active) {
            const activeCount = await this.getActiveAdminsCount();
            if (activeCount <= 1) {
              return { 
                allowed: false, 
                message: 'لا يمكن حذف آخر مشرف نشط في النظام. قم بتفعيل مشرف آخر أولاً.' 
              };
            }
          }
        }
        
        return { allowed: true, message: '' };
      }
      
      if (action === 'deactivate') {
        // لا يمكن تعطيل آخر مشرف نشط
        if (adminId) {
          const activeCount = await this.getActiveAdminsCount();
          if (activeCount <= 1) {
            return { 
              allowed: false, 
              message: 'لا يمكن تعطيل آخر مشرف نشط في النظام. يجب وجود مشرف نشط واحد على الأقل.' 
            };
          }
        }
        
        return { allowed: true, message: '' };
      }
      
      if (action === 'change_role') {
        // لا يمكن تغيير دور آخر مشرف نشط إلى دور بدون صلاحيات
        if (adminId) {
          const activeCount = await this.getActiveAdminsCount();
          if (activeCount <= 1) {
            const admin = await fetchDocument('admins', adminId);
            if (admin && admin.is_active) {
              return { 
                allowed: false, 
                message: 'لا يمكن تغيير دور آخر مشرف نشط. يجب وجود مشرف نشط واحد على الأقل بصلاحيات كاملة.' 
              };
            }
          }
        }
        
        return { allowed: true, message: '' };
      }
      
      return { allowed: true, message: '' };
      
    } catch (error) {
      console.error('❌ فشل التحقق من إمكانية تعديل المشرف:', error.message);
      return { allowed: false, message: 'فشل التحقق من الحالة. يرجى المحاولة مرة أخرى.' };
    }
  }

  /**
   * جلب قائمة المشرفين
   * @returns {Promise<Array>}
   */
  async getAdmins() {
    try {
      const result = await fetchDocuments('admins', {
        orderByField: 'createdAt',
        orderDirection: 'desc',
        limitCount: 20
      });

      const admins = (result.documents || []).map(admin => {
        const { password, ...safeAdmin } = admin;
        return safeAdmin;
      });

      return admins;
    } catch (error) {
      console.error('❌ فشل جلب المشرفين:', error.message);
      throw error;
    }
  }

  /**
   * إضافة مشرف جديد
   * @param {Object} adminData 
   * @returns {Promise<Object>}
   */
  async addAdmin(adminData) {
    try {
      if (!adminData.username || !adminData.username.trim()) {
        throw new Error('اسم المستخدم مطلوب');
      }

      if (adminData.username.trim().length < 3) {
        throw new Error('اسم المستخدم يجب أن يكون 3 أحرف على الأقل');
      }

      // التحقق من عدم تكرار اسم المستخدم
      const existing = await fetchDocuments('admins', {
        filters: [['username', '==', adminData.username.trim()]],
        limitCount: 1
      });

      if (existing.documents && existing.documents.length > 0) {
        throw new Error('اسم المستخدم موجود مسبقاً');
      }

      const password = adminData.password || generateSecurePassword(10);
      const hashedPassword = await hashPassword(password);

      const newAdmin = {
        username: adminData.username.trim(),
        password: hashedPassword,
        display_name: adminData.display_name || adminData.username.trim(),
        role: adminData.role || 'admin',
        permissions: adminData.permissions || [],
        is_active: true,
        last_login: null,
        createdAt: getServerTimestamp(),
        updatedAt: getServerTimestamp()
      };

      const adminId = await saveDocument('admins', null, newAdmin, false);

      try {
        await incrementField('counters', 'stats', 'total_admins', 1);
      } catch (e) {}

      cacheManager.invalidateAdminCache();

      showToast('تم إضافة المشرف بنجاح ✅', 'success');

      return { id: adminId, ...newAdmin, plainPassword: password };

    } catch (error) {
      showToast(error.message || 'فشل إضافة المشرف', 'error');
      throw error;
    }
  }

  /**
   * تعديل مشرف
   * @param {string} adminId 
   * @param {Object} updateData 
   * @returns {Promise<void>}
   */
  async updateAdmin(adminId, updateData) {
    try {
      const { password, ...safeData } = updateData;
      
      // التحقق من تغيير الدور
      if (safeData.role !== undefined || safeData.is_active === false) {
        const check = await this.canModifyAdmin(adminId, 
          safeData.is_active === false ? 'deactivate' : 'change_role'
        );
        if (!check.allowed) {
          throw new Error(check.message);
        }
      }
      
      await updateDocument('admins', adminId, {
        ...safeData,
        updatedAt: getServerTimestamp()
      });

      cacheManager.invalidateAdminCache();
      showToast('تم تحديث بيانات المشرف ✅', 'success');

    } catch (error) {
      showToast(error.message || 'فشل تحديث المشرف', 'error');
      throw error;
    }
  }

  /**
   * تغيير كلمة مرور مشرف
   * @param {string} adminId 
   * @param {string} newPassword 
   * @returns {Promise<string>}
   */
  async resetAdminPassword(adminId, newPassword = null) {
    try {
      const password = newPassword || generateSecurePassword(10);
      const hashedPassword = await hashPassword(password);

      await updateDocument('admins', adminId, {
        password: hashedPassword,
        updatedAt: getServerTimestamp()
      });

      showToast('تم تغيير كلمة المرور ✅', 'success');
      return password;

    } catch (error) {
      showToast('فشل تغيير كلمة المرور', 'error');
      throw error;
    }
  }

  /**
   * حذف مشرف
   * *** إصلاح #1: منع حذف آخر مشرف في النظام ***
   * @param {string} adminId 
   * @returns {Promise<void>}
   */
  async deleteAdmin(adminId) {
    try {
      // *** إصلاح #1: التحقق من أن المشرف ليس آخر مشرف ***
      const canDelete = await this.canModifyAdmin(adminId, 'delete');
      if (!canDelete.allowed) {
        showToast(canDelete.message, 'error');
        throw new Error(canDelete.message);
      }

      const confirmed = await showConfirm(
        'هل أنت متأكد من حذف هذا المشرف؟ لا يمكن التراجع عن هذا الإجراء.',
        'تأكيد الحذف',
        'نعم، احذف',
        'إلغاء'
      );

      if (!confirmed) return;

      await removeDocument('admins', adminId);

      try {
        await incrementField('counters', 'stats', 'total_admins', -1);
      } catch (e) {}

      // تسجيل العملية
      try {
        await saveDocument('system_logs', null, {
          action: 'admin_deleted',
          details: `تم حذف مشرف (${adminId})`,
          performed_by: 'admin',
          timestamp: getServerTimestamp()
        }, false);
      } catch (logError) {
        console.warn('⚠️ فشل تسجيل العملية:', logError.message);
      }

      cacheManager.invalidateAdminCache();
      showToast('تم حذف المشرف بنجاح 🗑️', 'success');

    } catch (error) {
      if (error.message.includes('لا يمكن حذف')) {
        throw error;
      }
      showToast(error.message || 'فشل حذف المشرف', 'error');
      throw error;
    }
  }

  /**
   * تبديل حالة مشرف (تفعيل/تعطيل)
   * *** إضافة: منع تعطيل آخر مشرف نشط ***
   * @param {string} adminId 
   * @returns {Promise<boolean>}
   */
  async toggleAdminStatus(adminId) {
    try {
      const admin = await fetchDocument('admins', adminId);
      if (!admin) throw new Error('المشرف غير موجود');

      const newStatus = !admin.is_active;

      // *** إضافة: التحقق قبل التعطيل ***
      if (!newStatus) {
        const canDeactivate = await this.canModifyAdmin(adminId, 'deactivate');
        if (!canDeactivate.allowed) {
          showToast(canDeactivate.message, 'error');
          throw new Error(canDeactivate.message);
        }
      }

      await updateDocument('admins', adminId, {
        is_active: newStatus,
        updatedAt: getServerTimestamp()
      });

      // تسجيل العملية
      try {
        await saveDocument('system_logs', null, {
          action: newStatus ? 'admin_activated' : 'admin_deactivated',
          details: newStatus 
            ? `تم تفعيل المشرف: ${admin.display_name || admin.username}` 
            : `تم تعطيل المشرف: ${admin.display_name || admin.username}`,
          performed_by: 'admin',
          timestamp: getServerTimestamp()
        }, false);
      } catch (logError) {
        console.warn('⚠️ فشل تسجيل العملية:', logError.message);
      }

      cacheManager.invalidateAdminCache();
      showToast(
        newStatus ? 'تم تفعيل المشرف ✅' : 'تم تعطيل المشرف ⚠️',
        newStatus ? 'success' : 'warning'
      );

      return newStatus;

    } catch (error) {
      if (error.message.includes('لا يمكن تعطيل')) {
        throw error;
      }
      showToast(error.message || 'فشل تغيير حالة المشرف', 'error');
      throw error;
    }
  }

  // ===========================
  // معلومات النظام
  // ===========================

  /**
   * الحصول على معلومات النظام
   * @returns {Promise<Object>}
   */
  async getSystemInfo() {
    try {
      const [settings, counters] = await Promise.all([
        this.getSettings(),
        fetchDocument('counters', 'stats')
      ]);

      return {
        version: settings?.system_version || '2.1.0',
        schoolName: settings?.school_name || 'مدارس الجيل الجديد',
        academicYear: settings?.current_academic_year || '—',
        term: settings?.current_term || '—',
        maintenanceMode: settings?.maintenance_mode || false,
        statistics: {
          students: counters?.total_students || 0,
          activeStudents: counters?.total_active_students || 0,
          inactiveStudents: counters?.total_inactive_students || 0,
          admins: counters?.total_admins || 0,
          announcements: counters?.total_announcements || 0,
          stages: counters?.total_stages || 0,
          classes: counters?.total_classes || 0
        }
      };
    } catch (error) {
      console.error('❌ فشل جلب معلومات النظام:', error.message);
      return null;
    }
  }

  /**
   * إعادة ضبط العدادات
   * @returns {Promise<void>}
   */
  async resetCounters() {
    try {
      const confirmed = await showConfirm(
        'سيتم إعادة حساب جميع العدادات من قاعدة البيانات. قد يستغرق هذا بعض الوقت. هل تريد المتابعة؟',
        'إعادة ضبط العدادات',
        'نعم',
        'إلغاء'
      );

      if (!confirmed) return;

      // جلب الإحصائيات الحقيقية
      const [studentsResult, adminsResult, announcementsResult] = await Promise.all([
        fetchDocuments('students', { limitCount: 1000 }),
        fetchDocuments('admins', { limitCount: 50 }),
        fetchDocuments('announcements', { limitCount: 100 })
      ]);

      const allStudents = studentsResult.documents || [];
      const activeStudents = allStudents.filter(s => s.status === 'active').length;
      const inactiveStudents = allStudents.filter(s => s.status === 'inactive').length;

      // تحديث العدادات
      await updateDocument('counters', 'stats', {
        total_students: allStudents.length,
        total_active_students: activeStudents,
        total_inactive_students: inactiveStudents,
        total_admins: (adminsResult.documents || []).length,
        total_announcements: (announcementsResult.documents || []).length,
        updatedAt: getServerTimestamp()
      });

      cacheManager.invalidateAdminCache();
      showToast('تم إعادة ضبط العدادات بنجاح ✅', 'success');

    } catch (error) {
      showToast('فشل إعادة ضبط العدادات', 'error');
      throw error;
    }
  }
}

// ===========================
// نسخة واحدة
// ===========================
const adminSettings = new AdminSettingsManager();

// ===========================
// تصدير
// ===========================
export {
  AdminSettingsManager,
  adminSettings
};

console.log('📦 Admin Settings Manager: جاهز | الإصدار 2.1 (مُصحح)');
console.log('✅ تم إضافة حماية من حذف آخر مشرف');
console.log('✅ تم إضافة حماية من تعطيل آخر مشرف نشط');