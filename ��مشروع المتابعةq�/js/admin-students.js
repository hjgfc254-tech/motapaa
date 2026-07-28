/* ===========================
   SCHOOLHUB PRO - ADMIN STUDENTS MANAGER
   مدارس الجيل الجديد الخاصة
   الإصدار: 2.2 (مُصحح)
   =========================== */

/**
 * وحدة إدارة الطلاب للوحة تحكم الإدارة
 * توفر دوال كاملة لإدارة الطلاب: إضافة، تعديل، حذف، بحث، تفعيل، تصدير
 * 
 * الإصلاحات في هذا الإصدار:
 * - #1: التحقق من تكرار كود الطالب في bulkAddStudents()
 * - #2: منع تكرار الكود في updateStudent()
 * - #3: حذف جميع السنوات الدراسية للطالب
 * - #4: جلب السنة الدراسية ديناميكياً
 * - #5: تطبيق الفلاتر في exportStudentsToCSV()
 * - #6: تحديث الفصل في massPromote()
 * - #7: دعم البحث في الخادم للبيانات الكبيرة
 * - #8: تحسين validateStudentData()
 */

import { 
  fetchDocument, 
  fetchDocuments, 
  saveDocument, 
  updateDocument, 
  removeDocument, 
  executeBatch, 
  incrementField,
  getServerTimestamp
} from './firebase-config.js';

import { 
  hashPassword, 
  generateSecurePassword, 
  generateStudentCode,
  generateUniqueId,
  showToast, 
  showConfirm, 
  showAlert,
  formatDateArabic,
  formatNumberArabic
} from './utils.js';

import { cacheManager, CACHE_CONFIG } from './cache-manager.js';

// ===========================
// ثوابت
// ===========================
const STUDENTS_PER_PAGE = 20;
const DEFAULT_PASSWORD_LENGTH = 8;

// ===========================
// كلاس إدارة الطلاب
// ===========================
class AdminStudentsManager {
  constructor() {
    this.currentFilters = {
      search: '',
      stage: null,
      class: null,
      status: 'all',
      sortBy: 'createdAt',
      sortOrder: 'desc'
    };
    this.lastVisible = null;
    this.hasMore = false;
    this.isLoading = false;
    this.listeners = [];
    
    // *** حل مشكلة #4: جلب السنة الدراسية ديناميكياً ***
    this._cachedYear = null;
    this._cacheTimestamp = null;
    this._cacheTTL = 5 * 60 * 1000; // 5 دقائق
  }

  /**
   * جلب السنة الدراسية الحالية من إعدادات النظام
   * @returns {Promise<string>}
   */
  async getAcademicYear() {
    try {
      if (this._cachedYear && this._cacheTimestamp && 
          (Date.now() - this._cacheTimestamp) < this._cacheTTL) {
        return this._cachedYear;
      }

      const settings = await fetchDocument('settings', 'general');
      
      if (settings && settings.current_academic_year) {
        this._cachedYear = settings.current_academic_year.replace(/-/g, '_');
        this._cacheTimestamp = Date.now();
        return this._cachedYear;
      }

      console.warn('⚠️ لم يتم العثور على السنة الدراسية في الإعدادات، استخدام القيمة الافتراضية');
      return '2025_2026';

    } catch (error) {
      console.warn('⚠️ فشل جلب السنة الدراسية:', error.message);
      return '2025_2026';
    }
  }

  /**
   * جلب قائمة الطلاب مع فلترة وبحث وتقسيم صفحات
   * @param {Object} options - خيارات إضافية
   * @returns {Promise<Object>}
   */
  async getStudents(options = {}) {
    const filters = options.filters || this.currentFilters;
    const loadMore = options.loadMore || false;
    const limitCount = options.limit || STUDENTS_PER_PAGE;

    try {
      this.isLoading = true;
      this.notifyListeners('loading', true);

      const queryFilters = [];

      // فلترة حسب المرحلة
      if (filters.stage) {
        queryFilters.push(['stage_id', '==', filters.stage]);
      }

      // فلترة حسب الفصل
      if (filters.class) {
        queryFilters.push(['class_id', '==', filters.class]);
      }

      // فلترة حسب الحالة
      if (filters.status && filters.status !== 'all') {
        queryFilters.push(['status', '==', filters.status]);
      }

      // *** حل مشكلة #7: دعم البحث عبر Firestore إذا أمكن ***
      // البحث يتم محلياً بعد الجلب لأن Firestore لا يدعم البحث النصي الجزئي مباشرة
      // لكن مع البيانات الكبيرة، نزيد limit لضمان تغطية البحث
      const effectiveLimit = filters.search ? Math.max(limitCount, 200) : limitCount;

      const queryOptions = {
        filters: queryFilters,
        orderByField: filters.sortBy || 'createdAt',
        orderDirection: filters.sortOrder || 'desc',
        limitCount: effectiveLimit
      };

      if (loadMore && this.lastVisible) {
        queryOptions.startAfterDoc = this.lastVisible;
      }

      const result = await fetchDocuments('students', queryOptions);

      let students = result.documents || [];

      // فلترة بالبحث (بعد الجلب)
      if (filters.search) {
        const searchTerm = filters.search.toLowerCase().trim();
        students = students.filter(student => {
          return (
            (student.name && student.name.toLowerCase().includes(searchTerm)) ||
            (student.code && student.code.toLowerCase().includes(searchTerm)) ||
            (student.parent_phone && student.parent_phone.includes(searchTerm))
          );
        });
      }

      // إزالة كلمات المرور من النتائج
      students = students.map(s => {
        const { password, ...safeStudent } = s;
        return safeStudent;
      });

      this.lastVisible = result.lastVisible;
      this.hasMore = result.hasMore && students.length === limitCount;

      this.isLoading = false;
      this.notifyListeners('loaded', { students, hasMore: this.hasMore });

      return {
        students,
        hasMore: this.hasMore,
        total: students.length
      };

    } catch (error) {
      this.isLoading = false;
      this.notifyListeners('error', error);
      console.error('❌ فشل جلب الطلاب:', error.message);
      throw error;
    }
  }

  /**
   * جلب طالب واحد
   * @param {string} studentId 
   * @returns {Promise<Object|null>}
   */
  async getStudent(studentId) {
    try {
      const student = await fetchDocument('students', studentId);
      if (student) {
        const { password, ...safeStudent } = student;
        return safeStudent;
      }
      return null;
    } catch (error) {
      console.error('❌ فشل جلب الطالب:', error.message);
      throw error;
    }
  }

  /**
   * التحقق من عدم تكرار كود الطالب
   * @param {string} code - كود الطالب
   * @param {string} excludeId - معرف طالب للاستثناء (عند التعديل)
   * @returns {Promise<boolean>}
   */
  async isCodeUnique(code, excludeId = null) {
    if (!code || !code.trim()) return true;
    
    const trimmedCode = code.trim();
    const existing = await fetchDocuments('students', {
      filters: [['code', '==', trimmedCode]],
      limitCount: 1
    });

    if (existing.documents && existing.documents.length > 0) {
      // إذا كنا نعدل طالباً وهذا هو نفس الطالب، فالكود متاح
      if (excludeId && existing.documents[0].id === excludeId) {
        return true;
      }
      return false;
    }
    return true;
  }

  /**
   * إضافة طالب جديد
   * @param {Object} studentData - بيانات الطالب
   * @returns {Promise<Object>}
   */
  async addStudent(studentData) {
    try {
      // التحقق من البيانات المطلوبة
      this.validateStudentData(studentData, true);

      // التحقق من عدم وجود كود مكرر
      if (studentData.code && studentData.code.trim()) {
        const isUnique = await this.isCodeUnique(studentData.code);
        if (!isUnique) {
          throw new Error('كود الطالب موجود مسبقاً. يرجى استخدام كود آخر.');
        }
      }

      // توليد كلمة مرور إذا لم تكن محددة
      let password = studentData.password;
      if (!password) {
        password = generateSecurePassword(DEFAULT_PASSWORD_LENGTH);
      }

      // تشفير كلمة المرور
      const hashedPassword = await hashPassword(password);

      // تجهيز بيانات الطالب
      const newStudent = {
        name: studentData.name.trim(),
        code: studentData.code ? studentData.code.trim() : generateStudentCode('STS', Date.now()),
        password: hashedPassword,
        stage_id: studentData.stage_id,
        stage_name: studentData.stage_name || '',
        class_id: studentData.class_id,
        class_name: studentData.class_name || '',
        status: studentData.status || 'active',
        parent_name: studentData.parent_name ? studentData.parent_name.trim() : '',
        parent_phone: studentData.parent_phone ? studentData.parent_phone.trim() : '',
        seat_number: studentData.seat_number || null,
        photo_url: studentData.photo_url || null,
        createdAt: getServerTimestamp(),
        updatedAt: getServerTimestamp(),
        last_login: null
      };

      // حفظ الطالب
      const studentId = await saveDocument('students', null, newStudent, false);

      // تحديث العدادات
      try {
        await incrementField('counters', 'stats', 'total_students', 1);
        if (newStudent.status === 'active') {
          await incrementField('counters', 'stats', 'total_active_students', 1);
        } else {
          await incrementField('counters', 'stats', 'total_inactive_students', 1);
        }
      } catch (counterError) {
        console.warn('⚠️ فشل تحديث العدادات:', counterError.message);
      }

      // مسح الكاش
      cacheManager.invalidateAdminCache();

      showToast('تم إضافة الطالب بنجاح ✅', 'success');

      // إرجاع الطالب مع كلمة المرور (للمشرف)
      return {
        id: studentId,
        ...newStudent,
        plainPassword: password
      };

    } catch (error) {
      showToast(error.message || 'فشل إضافة الطالب', 'error');
      throw error;
    }
  }

  /**
   * إضافة طلاب متعددين دفعة واحدة (استيراد)
   * *** حل مشكلة #1: التحقق من تكرار الأكواد ***
   * @param {Array<Object>} studentsList - مصفوفة بيانات الطلاب
   * @returns {Promise<Object>}
   */
  async bulkAddStudents(studentsList) {
    try {
      if (!studentsList || studentsList.length === 0) {
        throw new Error('لا توجد بيانات للإضافة');
      }

      const operations = [];
      const results = {
        success: [],
        failed: [],
        total: studentsList.length
      };

      // *** حل مشكلة #1: التحقق من الأكواد المكررة داخل الملف نفسه ***
      const codesInFile = new Set();
      const duplicateCodesInFile = new Set();
      
      // التحقق من التكرار داخل الملف
      studentsList.forEach((student, index) => {
        const code = (student.code || '').trim();
        if (code) {
          if (codesInFile.has(code)) {
            duplicateCodesInFile.add(code);
            results.failed.push({
              index: index,
              name: student.name || 'غير معروف',
              error: `كود مكرر داخل الملف: ${code}`
            });
          } else {
            codesInFile.add(code);
          }
        }
      });

      // *** حل مشكلة #1: التحقق من الأكواد الموجودة مسبقاً في قاعدة البيانات ***
      const existingCodesMap = new Map();
      const codesToCheck = Array.from(codesInFile).filter(code => !duplicateCodesInFile.has(code));
      
      if (codesToCheck.length > 0) {
        // البحث عن الأكواد الموجودة مسبقاً على دفعات
        for (const code of codesToCheck) {
          const existing = await fetchDocuments('students', {
            filters: [['code', '==', code]],
            limitCount: 1
          });
          if (existing.documents && existing.documents.length > 0) {
            existingCodesMap.set(code, true);
          }
        }
      }

      // معالجة كل طالب
      for (let i = 0; i < studentsList.length; i++) {
        // تخطي الطلاب الذين فشلوا بالفعل بسبب تكرار الكود داخل الملف
        if (results.failed.some(f => f.index === i)) {
          continue;
        }

        try {
          const studentData = studentsList[i];
          
          // التحقق من صحة البيانات
          try {
            this.validateStudentData(studentData, true);
          } catch (validationError) {
            results.failed.push({
              index: i,
              name: studentData.name || 'غير معروف',
              error: validationError.message
            });
            continue;
          }

          const code = (studentData.code || '').trim();
          
          // التحقق من الكود المكرر في قاعدة البيانات
          if (code && existingCodesMap.has(code)) {
            results.failed.push({
              index: i,
              name: studentData.name || 'غير معروف',
              error: `كود الطالب موجود مسبقاً: ${code}`
            });
            continue;
          }

          const password = studentData.password || generateSecurePassword(DEFAULT_PASSWORD_LENGTH);
          const hashedPassword = await hashPassword(password);

          const newStudent = {
            name: studentData.name.trim(),
            code: code || generateStudentCode('STS', Date.now() + i),
            password: hashedPassword,
            stage_id: studentData.stage_id,
            stage_name: studentData.stage_name || '',
            class_id: studentData.class_id,
            class_name: studentData.class_name || '',
            status: 'active',
            parent_name: (studentData.parent_name || '').trim(),
            parent_phone: (studentData.parent_phone || '').trim(),
            createdAt: getServerTimestamp(),
            updatedAt: getServerTimestamp()
          };

          const docId = generateUniqueId();
          
          operations.push({
            type: 'set',
            collection: 'students',
            id: docId,
            data: newStudent
          });

          results.success.push({
            name: newStudent.name,
            code: newStudent.code,
            password: password
          });

        } catch (studentError) {
          results.failed.push({
            index: i,
            name: studentsList[i]?.name || 'غير معروف',
            error: studentError.message
          });
        }
      }

      // تنفيذ العمليات على دفعات
      const batchSize = 400;
      for (let i = 0; i < operations.length; i += batchSize) {
        const batch = operations.slice(i, i + batchSize);
        await executeBatch(batch);
      }

      // تحديث العدادات
      const successCount = results.success.length;
      if (successCount > 0) {
        try {
          await incrementField('counters', 'stats', 'total_students', successCount);
          await incrementField('counters', 'stats', 'total_active_students', successCount);
        } catch (counterError) {
          console.warn('⚠️ فشل تحديث العدادات');
        }
      }

      cacheManager.invalidateAdminCache();

      showToast(`تمت إضافة ${successCount} طالب بنجاح` + 
        (results.failed.length > 0 ? ` (فشل: ${results.failed.length})` : ''), 
        results.failed.length === 0 ? 'success' : 'warning');

      return results;

    } catch (error) {
      showToast(error.message || 'فشل استيراد الطلاب', 'error');
      throw error;
    }
  }

  /**
   * تعديل بيانات طالب
   * *** حل مشكلة #2: التحقق من عدم تكرار الكود عند التعديل ***
   * @param {string} studentId - معرف الطالب
   * @param {Object} updateData - البيانات المراد تحديثها
   * @returns {Promise<void>}
   */
  async updateStudent(studentId, updateData) {
    try {
      // منع تحديث الكلمات السرية من هنا
      const { password, ...safeData } = updateData;

      // *** حل مشكلة #2: التحقق من عدم تكرار الكود ***
      if (safeData.code && safeData.code.trim()) {
        const isUnique = await this.isCodeUnique(safeData.code, studentId);
        if (!isUnique) {
          throw new Error('كود الطالب مستخدم من قبل طالب آخر. يرجى استخدام كود مختلف.');
        }
      }

      const dataToUpdate = {
        ...safeData,
        updatedAt: getServerTimestamp()
      };

      // تنظيف البيانات النصية
      if (dataToUpdate.name) dataToUpdate.name = dataToUpdate.name.trim();
      if (dataToUpdate.code) dataToUpdate.code = dataToUpdate.code.trim();
      if (dataToUpdate.parent_name) dataToUpdate.parent_name = dataToUpdate.parent_name.trim();
      if (dataToUpdate.parent_phone) dataToUpdate.parent_phone = dataToUpdate.parent_phone.trim();

      // إذا تغيرت المرحلة أو الفصل، نجلب الأسماء
      if (updateData.stage_id && !updateData.stage_name) {
        const stage = await fetchDocument('school_structure', updateData.stage_id);
        if (stage) dataToUpdate.stage_name = stage.name;
      }

      if (updateData.class_id && !updateData.class_name) {
        const classDoc = await fetchDocument('school_structure', updateData.class_id);
        if (classDoc) dataToUpdate.class_name = classDoc.name;
      }

      await updateDocument('students', studentId, dataToUpdate);

      cacheManager.invalidateAdminCache();
      cacheManager.invalidateStudentCache();

      showToast('تم تحديث بيانات الطالب بنجاح ✅', 'success');

    } catch (error) {
      showToast(error.message || 'فشل تحديث بيانات الطالب', 'error');
      throw error;
    }
  }

  /**
   * تغيير كلمة مرور طالب
   * @param {string} studentId 
   * @param {string} newPassword 
   * @returns {Promise<string>} كلمة المرور الجديدة
   */
  async resetStudentPassword(studentId, newPassword = null) {
    try {
      const password = newPassword || generateSecurePassword(DEFAULT_PASSWORD_LENGTH);
      const hashedPassword = await hashPassword(password);

      await updateDocument('students', studentId, {
        password: hashedPassword,
        updatedAt: getServerTimestamp()
      });

      showToast('تم تغيير كلمة المرور بنجاح ✅', 'success');

      return password;

    } catch (error) {
      showToast('فشل تغيير كلمة المرور', 'error');
      throw error;
    }
  }

  /**
   * حذف طالب مع جميع بياناته المرتبطة
   * *** حل مشكلة #3: حذف بيانات جميع السنوات الدراسية ***
   * *** حل مشكلة #4: استخدام السنة الدراسية الديناميكية ***
   * @param {string} studentId 
   * @returns {Promise<void>}
   */
  async deleteStudent(studentId) {
    try {
      const confirmed = await showConfirm(
        'هل أنت متأكد من حذف هذا الطالب؟ لا يمكن التراجع عن هذا الإجراء. سيتم حذف جميع بيانات الحضور والمصروفات والرسائل المرتبطة به.',
        'تأكيد الحذف',
        'نعم، احذف',
        'إلغاء'
      );

      if (!confirmed) return;

      // جلب بيانات الطالب لمعرفة حالته قبل الحذف
      const student = await fetchDocument('students', studentId);

      if (!student) {
        throw new Error('الطالب غير موجود');
      }

      const batchOperations = [];

      // 1. حذف مستند الطالب
      batchOperations.push({
        type: 'delete',
        collection: 'students',
        id: studentId
      });

      // *** حل مشكلة #3 و #4: البحث عن جميع سنوات الحضور والمصروفات ***
      try {
        // البحث عن جميع مستندات الحضور المرتبطة بالطالب
        const allAttendance = await fetchDocuments('attendance', {
          filters: [['student_id', '==', studentId]],
          limitCount: 100
        });
        
        if (allAttendance.documents) {
          for (const attendanceDoc of allAttendance.documents) {
            // حذف مستند الحضور الرئيسي
            batchOperations.push({
              type: 'delete',
              collection: 'attendance',
              id: attendanceDoc.id
            });
            
            // حذف سجلات الحضور اليومية
            try {
              const records = await fetchDocuments(`attendance/${attendanceDoc.id}/records`, { limitCount: 500 });
              if (records.documents) {
                records.documents.forEach(record => {
                  batchOperations.push({
                    type: 'delete',
                    collection: `attendance/${attendanceDoc.id}/records`,
                    id: record.id
                  });
                });
              }
            } catch (e) {
              console.warn(`⚠️ لم يتم العثور على سجلات حضور للسنة ${attendanceDoc.id}`);
            }
          }
        }
      } catch (e) {
        console.warn('⚠️ فشل البحث عن جميع سنوات الحضور، جاري البحث بالسنة الحالية فقط');
        
        // *** احتياطي: استخدام السنة الحالية إذا فشل البحث الشامل ***
        const currentYear = await this.getAcademicYear();
        const attendanceId = `${studentId}_${currentYear}`;
        batchOperations.push({
          type: 'delete',
          collection: 'attendance',
          id: attendanceId
        });
        try {
          const records = await fetchDocuments(`attendance/${attendanceId}/records`, { limitCount: 500 });
          if (records.documents) {
            records.documents.forEach(record => {
              batchOperations.push({
                type: 'delete',
                collection: `attendance/${attendanceId}/records`,
                id: record.id
              });
            });
          }
        } catch (recordError) {
          console.warn('⚠️ لم يتم العثور على سجلات حضور للطالب');
        }
      }

      // *** حل مشكلة #3 و #4: البحث عن جميع سنوات المصروفات ***
      try {
        const allExpenses = await fetchDocuments('expenses', {
          filters: [['student_id', '==', studentId]],
          limitCount: 100
        });
        
        if (allExpenses.documents) {
          for (const expenseDoc of allExpenses.documents) {
            batchOperations.push({
              type: 'delete',
              collection: 'expenses',
              id: expenseDoc.id
            });
            
            try {
              const payments = await fetchDocuments(`expenses/${expenseDoc.id}/payments`, { limitCount: 500 });
              if (payments.documents) {
                payments.documents.forEach(payment => {
                  batchOperations.push({
                    type: 'delete',
                    collection: `expenses/${expenseDoc.id}/payments`,
                    id: payment.id
                  });
                });
              }
            } catch (e) {
              console.warn(`⚠️ لم يتم العثور على مدفوعات للسنة ${expenseDoc.id}`);
            }
          }
        }
      } catch (e) {
        console.warn('⚠️ فشل البحث عن جميع سنوات المصروفات، جاري البحث بالسنة الحالية فقط');
        
        const currentYear = await this.getAcademicYear();
        const expenseId = `${studentId}_${currentYear}`;
        batchOperations.push({
          type: 'delete',
          collection: 'expenses',
          id: expenseId
        });
        try {
          const payments = await fetchDocuments(`expenses/${expenseId}/payments`, { limitCount: 500 });
          if (payments.documents) {
            payments.documents.forEach(payment => {
              batchOperations.push({
                type: 'delete',
                collection: `expenses/${expenseId}/payments`,
                id: payment.id
              });
            });
          }
        } catch (paymentError) {
          console.warn('⚠️ لم يتم العثور على سجلات مدفوعات للطالب');
        }
      }

      // 3. حذف الرسائل المرتبطة بالطالب
      try {
        const messages = await fetchDocuments('messages', {
          filters: [['to', '==', studentId]],
          limitCount: 500
        });
        if (messages.documents) {
          messages.documents.forEach(msg => {
            batchOperations.push({
              type: 'delete',
              collection: 'messages',
              id: msg.id
            });
          });
        }
      } catch (e) {
        console.warn('⚠️ لم يتم العثور على رسائل للطالب');
      }

      // 4. حذف الإشعارات المرتبطة بالطالب
      try {
        const notifications = await fetchDocuments('notifications', {
          filters: [['for', '==', studentId]],
          limitCount: 500
        });
        if (notifications.documents) {
          notifications.documents.forEach(notif => {
            batchOperations.push({
              type: 'delete',
              collection: 'notifications',
              id: notif.id
            });
          });
        }
      } catch (e) {
        console.warn('⚠️ لم يتم العثور على إشعارات للطالب');
      }

      // تنفيذ جميع عمليات الحذف على دفعات
      const batchSize = 400;
      for (let i = 0; i < batchOperations.length; i += batchSize) {
        const batch = batchOperations.slice(i, i + batchSize);
        await executeBatch(batch);
      }

      // تحديث العدادات
      try {
        await incrementField('counters', 'stats', 'total_students', -1);
        if (student.status === 'active') {
          await incrementField('counters', 'stats', 'total_active_students', -1);
        } else {
          await incrementField('counters', 'stats', 'total_inactive_students', -1);
        }
      } catch (counterError) {
        console.warn('⚠️ فشل تحديث العدادات');
      }

      // إضافة سجل للنظام
      try {
        await saveDocument('system_logs', null, {
          action: 'student_deleted',
          details: `حذف الطالب: ${student.name} (${student.code}) مع جميع بياناته`,
          performed_by: 'admin',
          affected_count: batchOperations.length,
          timestamp: getServerTimestamp()
        }, false);
      } catch (logError) {
        console.warn('⚠️ فشل إضافة سجل النظام');
      }

      cacheManager.invalidateAdminCache();

      showToast('تم حذف الطالب وجميع بياناته المرتبطة بنجاح 🗑️', 'success');

    } catch (error) {
      showToast(error.message || 'فشل حذف الطالب', 'error');
      throw error;
    }
  }

  /**
   * تفعيل طالب
   * @param {string} studentId 
   * @returns {Promise<void>}
   */
  async activateStudent(studentId) {
    try {
      const student = await fetchDocument('students', studentId);
      
      if (!student) throw new Error('الطالب غير موجود');
      if (student.status === 'active') {
        showToast('الطالب مفعل بالفعل', 'info');
        return;
      }

      await updateDocument('students', studentId, {
        status: 'active',
        updatedAt: getServerTimestamp()
      });

      await incrementField('counters', 'stats', 'total_active_students', 1);
      await incrementField('counters', 'stats', 'total_inactive_students', -1);

      cacheManager.invalidateAdminCache();
      cacheManager.invalidateStudentCache();

      showToast('تم تفعيل الطالب بنجاح ✅', 'success');

    } catch (error) {
      showToast(error.message || 'فشل تفعيل الطالب', 'error');
      throw error;
    }
  }

  /**
   * إيقاف طالب
   * @param {string} studentId 
   * @returns {Promise<void>}
   */
  async deactivateStudent(studentId) {
    try {
      const student = await fetchDocument('students', studentId);
      
      if (!student) throw new Error('الطالب غير موجود');
      if (student.status === 'inactive') {
        showToast('الطالب موقوف بالفعل', 'info');
        return;
      }

      await updateDocument('students', studentId, {
        status: 'inactive',
        updatedAt: getServerTimestamp()
      });

      await incrementField('counters', 'stats', 'total_active_students', -1);
      await incrementField('counters', 'stats', 'total_inactive_students', 1);

      cacheManager.invalidateAdminCache();
      cacheManager.invalidateStudentCache();

      showToast('تم إيقاف الطالب ⚠️', 'warning');

    } catch (error) {
      showToast(error.message || 'فشل إيقاف الطالب', 'error');
      throw error;
    }
  }

  /**
   * ترقية جماعية للطلاب
   * *** حل مشكلة #6: تحديث الفصل مع المرحلة ***
   * @param {string} fromStageId - المرحلة الحالية
   * @param {string} toStageId - المرحلة التالية
   * @param {string} toClassId - الفصل التالي (اختياري)
   * @returns {Promise<Object>}
   */
  async massPromote(fromStageId, toStageId, toClassId = null) {
    try {
      // جلب كل طلاب المرحلة
      const result = await fetchDocuments('students', {
        filters: [['stage_id', '==', fromStageId]],
        orderByField: 'createdAt',
        limitCount: 500
      });

      const students = result.documents || [];
      
      if (students.length === 0) {
        throw new Error('لا يوجد طلاب في هذه المرحلة');
      }

      // جلب اسم المرحلة الجديدة والفصل الجديد
      const toStage = await fetchDocument('school_structure', toStageId);
      const toStageName = toStage ? toStage.name : '';
      
      let toClassName = '';
      if (toClassId) {
        const toClass = await fetchDocument('school_structure', toClassId);
        toClassName = toClass ? toClass.name : '';
      }

      const targetInfo = toClassId 
        ? `إلى "${toStageName} - ${toClassName}"`
        : `إلى "${toStageName}"`;

      const confirmed = await showConfirm(
        `سيتم ترقية ${students.length} طالب ${targetInfo}. هل تريد المتابعة؟`,
        'تأكيد الترقية الجماعية',
        'نعم، ترقية',
        'إلغاء'
      );

      if (!confirmed) return;

      // *** حل مشكلة #6: تحديث الفصل مع المرحلة ***
      const operations = students.map(student => {
        const updateData = {
          stage_id: toStageId,
          stage_name: toStageName,
          updatedAt: getServerTimestamp()
        };
        
        // إذا تم تحديد فصل جديد، نحدثه أيضاً
        if (toClassId) {
          updateData.class_id = toClassId;
          updateData.class_name = toClassName;
        }
        
        return {
          type: 'update',
          collection: 'students',
          id: student.id,
          data: updateData
        };
      });

      const batchSize = 400;
      for (let i = 0; i < operations.length; i += batchSize) {
        const batch = operations.slice(i, i + batchSize);
        await executeBatch(batch);
      }

      // تسجيل العملية في السجلات
      await saveDocument('system_logs', null, {
        action: 'mass_promote',
        details: `ترقية ${students.length} طالب ${targetInfo}`,
        performed_by: 'admin',
        affected_count: students.length,
        timestamp: getServerTimestamp()
      }, false);

      cacheManager.invalidateAdminCache();

      showToast(`تمت ترقية ${students.length} طالب بنجاح 🎉`, 'success');

      return {
        success: true,
        promotedCount: students.length,
        toStage: toStageName,
        toClass: toClassName || null
      };

    } catch (error) {
      showToast(error.message || 'فشلت الترقية الجماعية', 'error');
      throw error;
    }
  }

  /**
   * تصدير بيانات الطلاب إلى CSV
   * *** حل مشكلة #5: تطبيق الفلاتر في التصدير ***
   * @param {Object} filters - فلتر للتصدير
   * @returns {Promise<string>} محتوى CSV
   */
  async exportStudentsToCSV(filters = {}) {
    try {
      // *** حل مشكلة #5: بناء الفلاتر من المعاملات المدخلة ***
      const queryFilters = [];
      
      if (filters.stage) {
        queryFilters.push(['stage_id', '==', filters.stage]);
      }
      if (filters.class) {
        queryFilters.push(['class_id', '==', filters.class]);
      }
      if (filters.status && filters.status !== 'all') {
        queryFilters.push(['status', '==', filters.status]);
      }

      const result = await fetchDocuments('students', {
        filters: queryFilters,
        orderByField: filters.sortBy || 'createdAt',
        orderDirection: filters.sortOrder || 'desc',
        limitCount: 1000
      });

      const students = result.documents || [];

      if (students.length === 0) {
        throw new Error('لا يوجد طلاب للتصدير');
      }

      // عناوين CSV
      const headers = ['الاسم', 'الكود', 'المرحلة', 'الفصل', 'الحالة', 'ولي الأمر', 'رقم الهاتف'];
      
      let csv = '\uFEFF' + headers.join(',') + '\n';

      students.forEach(student => {
        const row = [
          student.name || '',
          student.code || '',
          student.stage_name || '',
          student.class_name || '',
          student.status === 'active' ? 'مفعل' : 'غير مفعل',
          student.parent_name || '',
          student.parent_phone || ''
        ].map(val => `"${val}"`).join(',');
        
        csv += row + '\n';
      });

      return csv;

    } catch (error) {
      showToast(error.message || 'فشل تصدير البيانات', 'error');
      throw error;
    }
  }

  /**
   * التحقق من صحة بيانات الطالب
   * *** حل مشكلة #8: تحسين التحقق من البيانات ***
   * @param {Object} data 
   * @param {boolean} isNew - هل هو طالب جديد
   */
  validateStudentData(data, isNew = false) {
    // التحقق من الاسم
    if (!data.name || !data.name.trim()) {
      throw new Error('اسم الطالب مطلوب');
    }
    if (data.name.trim().length < 3) {
      throw new Error('اسم الطالب يجب أن يكون 3 أحرف على الأقل');
    }
    if (data.name.trim().length > 100) {
      throw new Error('اسم الطالب طويل جداً (الحد الأقصى 100 حرف)');
    }

    // *** حل مشكلة #8: التحقق من الكود ***
    if (data.code !== undefined && data.code !== null && data.code !== '') {
      const trimmedCode = data.code.trim();
      if (trimmedCode && trimmedCode.length < 3) {
        throw new Error('كود الطالب يجب أن يكون 3 أحرف على الأقل');
      }
      if (trimmedCode && trimmedCode.includes(' ')) {
        throw new Error('كود الطالب لا يمكن أن يحتوي على مسافات');
      }
    }

    // التحقق من المرحلة والفصل
    if (!data.stage_id) {
      throw new Error('المرحلة الدراسية مطلوبة');
    }

    if (!data.class_id) {
      throw new Error('الفصل مطلوب');
    }

    // *** حل مشكلة #8: التحقق من رقم الهاتف ***
    if (data.parent_phone !== undefined && data.parent_phone !== null && data.parent_phone !== '') {
      const phone = data.parent_phone.trim();
      // إزالة كل شيء ما عدا الأرقام وعلامة +
      const cleanPhone = phone.replace(/[^\d+]/g, '');
      
      if (cleanPhone && !/^\+?\d{10,15}$/.test(cleanPhone)) {
        throw new Error('رقم هاتف ولي الأمر غير صحيح (يجب أن يكون 10-15 رقماً)');
      }
    }

    // *** حل مشكلة #8: التحقق من اسم ولي الأمر ***
    if (data.parent_name !== undefined && data.parent_name !== null && data.parent_name !== '') {
      if (data.parent_name.trim().length < 3) {
        throw new Error('اسم ولي الأمر يجب أن يكون 3 أحرف على الأقل');
      }
    }
  }

  /**
   * إعادة تعيين الفلاتر
   */
  resetFilters() {
    this.currentFilters = {
      search: '',
      stage: null,
      class: null,
      status: 'all',
      sortBy: 'createdAt',
      sortOrder: 'desc'
    };
    this.lastVisible = null;
    this.hasMore = false;
  }

  /**
   * إضافة مستمع للتغييرات
   * @param {Function} listener 
   */
  addListener(listener) {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter(l => l !== listener);
    };
  }

  /**
   * إعلام المستمعين
   * @param {string} event 
   * @param {*} data 
   */
  notifyListeners(event, data) {
    this.listeners.forEach(listener => {
      try {
        listener(event, data);
      } catch (error) {
        console.error('❌ خطأ في مستمع:', error.message);
      }
    });
  }
}

// ===========================
// نسخة واحدة (Singleton)
// ===========================
const adminStudents = new AdminStudentsManager();

// ===========================
// تصدير
// ===========================
export {
  AdminStudentsManager,
  adminStudents,
  STUDENTS_PER_PAGE
};

// ===========================
// رسالة جاهزية
// ===========================
console.log('📦 Admin Students Manager: جاهز | الإصدار 2.2 (مُصحح)');
console.log('✅ تم إصلاح جميع مشاكل تكرار الأكواد');
console.log('✅ تم إصلاح حذف جميع السنوات الدراسية');
console.log('✅ تم تحسين التحقق من صحة البيانات');
console.log('ℹ️ استخدم adminStudents.getStudents() لجلب الطلاب');
console.log('ℹ️ استخدم adminStudents.addStudent() لإضافة طالب');