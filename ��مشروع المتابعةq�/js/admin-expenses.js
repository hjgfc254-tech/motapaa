/* ===========================
   SCHOOLHUB PRO - ADMIN EXPENSES MANAGER
   مدارس الجيل الجديد الخاصة
   الإصدار: 2.1
   =========================== */

/**
 * وحدة إدارة المصروفات للوحة تحكم الإدارة
 * تم إصلاحه:
 * - #7: السنة الدراسية تُجلب ديناميكياً من settings/general
 * - #20: استخدام ?? بدلاً من || لحساب remainingAmount
 */

import { 
  fetchDocument, 
  fetchDocuments, 
  saveDocument, 
  updateDocument, 
  removeDocument,
  getServerTimestamp
} from './firebase-config.js';

import { 
  showToast, 
  showConfirm,
  formatDateArabic,
  formatCurrency
} from './utils.js';

import { cacheManager, CACHE_CONFIG } from './cache-manager.js';

class AdminExpensesManager {
  constructor() {
    // السنة الدراسية تُجلب ديناميكياً من الإعدادات
    this._cachedYear = null;
    this._cacheTimestamp = null;
    this._cacheTTL = 5 * 60 * 1000; // 5 دقائق
  }

  /**
   * جلب السنة الدراسية الحالية من إعدادات النظام
   * تحويل الصيغة من "2025-2026" إلى "2025_2026"
   * @returns {Promise<string>}
   */
  async getAcademicYear() {
    try {
      // استخدام الكاش إذا كان صالحاً
      if (this._cachedYear && this._cacheTimestamp && 
          (Date.now() - this._cacheTimestamp) < this._cacheTTL) {
        return this._cachedYear;
      }

      const settings = await fetchDocument('settings', 'general');
      
      if (settings && settings.current_academic_year) {
        // تحويل "2025-2026" إلى "2025_2026"
        this._cachedYear = settings.current_academic_year.replace(/-/g, '_');
        this._cacheTimestamp = Date.now();
        return this._cachedYear;
      }

      // قيمة افتراضية احتياطية
      console.warn('⚠️ لم يتم العثور على السنة الدراسية في الإعدادات، استخدام القيمة الافتراضية');
      return '2025_2026';

    } catch (error) {
      console.warn('⚠️ فشل جلب السنة الدراسية:', error.message);
      return '2025_2026';
    }
  }

  /**
   * تعيين السنة الدراسية يدوياً (يتجاوز الكاش)
   * @param {string} year - السنة بصيغة "2025-2026" أو "2025_2026"
   */
  setAcademicYear(year) {
    this._cachedYear = year.replace(/-/g, '_');
    this._cacheTimestamp = Date.now();
    console.log('📅 تم تعيين السنة الدراسية:', this._cachedYear);
  }

  /**
   * مسح كاش السنة الدراسية (لإعادة الجلب من الإعدادات)
   */
  clearYearCache() {
    this._cachedYear = null;
    this._cacheTimestamp = null;
  }

  /**
   * جلب مصروفات طالب
   * @param {string} studentId 
   * @param {string} academicYear 
   * @returns {Promise<Object|null>}
   */
  async getStudentExpense(studentId, academicYear = null) {
    try {
      const year = academicYear ? academicYear.replace(/-/g, '_') : await this.getAcademicYear();
      const expenseId = `${studentId}_${year}`;
      return await fetchDocument('expenses', expenseId);
    } catch (error) {
      console.error('❌ فشل جلب المصروفات:', error.message);
      throw error;
    }
  }

  /**
   * جلب مصروفات فصل كامل
   * @param {string} classId 
   * @param {string} academicYear 
   * @returns {Promise<Array>}
   */
  async getClassExpenses(classId, academicYear = null) {
    try {
      const year = academicYear ? academicYear.replace(/-/g, '_') : await this.getAcademicYear();
      
      const studentsResult = await fetchDocuments('students', {
        filters: [['class_id', '==', classId]],
        limitCount: 50
      });

      const students = studentsResult.documents || [];
      const expensesList = [];

      for (const student of students) {
        const expenseId = `${student.id}_${year}`;
        try {
          const expense = await fetchDocument('expenses', expenseId);
          
          // إصلاح #20: استخدام ?? بدلاً من ||
          const requiredAmount = expense?.required_amount ?? 0;
          const paidAmount = expense?.paid_amount ?? 0;
          const remainingAmount = expense?.remaining_amount 
            ?? (requiredAmount - paidAmount) 
            ?? 0;

          expensesList.push({
            studentId: student.id,
            studentName: student.name,
            studentCode: student.code,
            requiredAmount,
            paidAmount,
            remainingAmount: Math.max(0, remainingAmount),
            lastPaymentDate: expense?.last_payment_date || null,
            hasExpense: !!expense
          });
        } catch (e) {
          expensesList.push({
            studentId: student.id,
            studentName: student.name,
            studentCode: student.code,
            requiredAmount: 0,
            paidAmount: 0,
            remainingAmount: 0,
            lastPaymentDate: null,
            hasExpense: false
          });
        }
      }

      return expensesList;

    } catch (error) {
      console.error('❌ فشل جلب مصروفات الفصل:', error.message);
      throw error;
    }
  }

  /**
   * تعيين مصروفات طالب
   * @param {string} studentId 
   * @param {Object} data 
   * @param {string} academicYear 
   * @returns {Promise<string>}
   */
  async setStudentExpense(studentId, data, academicYear = null) {
    try {
      const year = academicYear ? academicYear.replace(/-/g, '_') : await this.getAcademicYear();
      const expenseId = `${studentId}_${year}`;
      const existing = await fetchDocument('expenses', expenseId);

      if (!data.required_amount || data.required_amount <= 0) {
        throw new Error('المبلغ المطلوب يجب أن يكون أكبر من صفر');
      }

      // حساب المبلغ المتبقي بشكل صحيح
      const requiredAmount = data.required_amount;
      const paidAmount = data.paid_amount ?? 0;
      const remainingAmount = data.remaining_amount !== undefined 
        ? data.remaining_amount 
        : Math.max(0, requiredAmount - paidAmount);

      const expenseData = {
        student_id: studentId,
        year: year,
        required_amount: requiredAmount,
        paid_amount: paidAmount,
        remaining_amount: remainingAmount,
        last_payment_date: data.last_payment_date || null,
        updatedAt: getServerTimestamp()
      };

      if (!existing) {
        expenseData.createdAt = getServerTimestamp();
        await saveDocument('expenses', expenseId, expenseData, false);
      } else {
        await updateDocument('expenses', expenseId, expenseData);
      }

      cacheManager.invalidate(CACHE_CONFIG.keys.student_expenses);
      cacheManager.invalidateAdminCache();

      showToast('تم حفظ المصروفات بنجاح ✅', 'success');
      return expenseId;

    } catch (error) {
      showToast(error.message || 'فشل حفظ المصروفات', 'error');
      throw error;
    }
  }

  /**
   * تعيين مصروفات جماعية
   * @param {Array} expensesData 
   * @param {string} academicYear 
   * @returns {Promise<Object>}
   */
  async setBulkExpenses(expensesData, academicYear = null) {
    try {
      const year = academicYear ? academicYear.replace(/-/g, '_') : await this.getAcademicYear();
      const results = { success: [], failed: [] };

      for (const data of expensesData) {
        try {
          await this.setStudentExpense(data.studentId, {
            required_amount: data.required_amount,
            paid_amount: data.paid_amount || 0,
            last_payment_date: data.last_payment_date || null
          }, year);
          results.success.push(data.studentId);
        } catch (e) {
          results.failed.push({ studentId: data.studentId, error: e.message });
        }
      }

      showToast(
        `تم حفظ ${results.success.length} مصروف` + 
        (results.failed.length > 0 ? ` (فشل: ${results.failed.length})` : ''),
        results.failed.length === 0 ? 'success' : 'warning'
      );

      return results;

    } catch (error) {
      showToast(error.message || 'فشل الحفظ الجماعي', 'error');
      throw error;
    }
  }

  /**
   * تسجيل دفعة لطالب
   * @param {string} studentId 
   * @param {number} amount 
   * @param {string} method 
   * @param {string} academicYear 
   * @returns {Promise<Object>}
   */
  async recordPayment(studentId, amount, method = 'نقدي', academicYear = null) {
    try {
      if (!amount || amount <= 0) {
        throw new Error('المبلغ المدفوع يجب أن يكون أكبر من صفر');
      }

      const year = academicYear ? academicYear.replace(/-/g, '_') : await this.getAcademicYear();
      const expenseId = `${studentId}_${year}`;
      const expense = await fetchDocument('expenses', expenseId);

      if (!expense) {
        throw new Error('لا توجد مصروفات مسجلة لهذا الطالب. قم بتعيين المصروفات أولاً.');
      }

      const currentPaid = expense.paid_amount ?? 0;
      const requiredAmount = expense.required_amount ?? 0;
      const newPaidAmount = currentPaid + amount;
      const newRemaining = Math.max(0, requiredAmount - newPaidAmount);

      await updateDocument('expenses', expenseId, {
        paid_amount: newPaidAmount,
        remaining_amount: newRemaining,
        last_payment_date: getServerTimestamp(),
        updatedAt: getServerTimestamp()
      });

      const paymentData = {
        amount: amount,
        method: method,
        payment_date: getServerTimestamp(),
        note: ''
      };

      await saveDocument(`expenses/${expenseId}/payments`, null, paymentData, false);

      cacheManager.invalidate(CACHE_CONFIG.keys.student_expenses);
      cacheManager.invalidateAdminCache();

      showToast(`تم تسجيل دفعة بقيمة ${formatCurrency(amount)} ✅`, 'success');
      return { newPaidAmount, newRemaining };

    } catch (error) {
      showToast(error.message || 'فشل تسجيل الدفعة', 'error');
      throw error;
    }
  }

  /**
   * جلب سجل المدفوعات لطالب
   * @param {string} studentId 
   * @param {string} academicYear 
   * @returns {Promise<Array>}
   */
  async getPaymentHistory(studentId, academicYear = null) {
    try {
      const year = academicYear ? academicYear.replace(/-/g, '_') : await this.getAcademicYear();
      const expenseId = `${studentId}_${year}`;

      const result = await fetchDocuments(`expenses/${expenseId}/payments`, {
        orderByField: 'payment_date',
        orderDirection: 'desc',
        limitCount: 30
      });

      return result.documents || [];
    } catch (error) {
      console.error('❌ فشل جلب سجل المدفوعات:', error.message);
      return [];
    }
  }

  /**
   * حذف مصروفات طالب
   * @param {string} studentId 
   * @param {string} academicYear 
   * @returns {Promise<void>}
   */
  async deleteExpense(studentId, academicYear = null) {
    try {
      const year = academicYear ? academicYear.replace(/-/g, '_') : await this.getAcademicYear();
      const expenseId = `${studentId}_${year}`;
      const existing = await fetchDocument('expenses', expenseId);

      if (!existing) {
        showToast('لا توجد مصروفات لهذا الطالب', 'info');
        return;
      }

      const student = await fetchDocument('students', studentId);
      const studentName = student?.name || 'غير معروف';

      const confirmed = await showConfirm(
        `هل أنت متأكد من حذف مصروفات "${studentName}"؟`,
        'تأكيد الحذف',
        'نعم، احذف',
        'إلغاء'
      );

      if (!confirmed) return;

      await removeDocument('expenses', expenseId);

      cacheManager.invalidate(CACHE_CONFIG.keys.student_expenses);
      cacheManager.invalidateAdminCache();

      showToast('تم حذف المصروفات بنجاح 🗑️', 'success');

    } catch (error) {
      showToast(error.message || 'فشل حذف المصروفات', 'error');
      throw error;
    }
  }

  /**
   * جلب ملخص المصروفات (لفصل أو للمدرسة كاملة)
   * @param {string} classId 
   * @param {string} academicYear 
   * @returns {Promise<Object>}
   */
  async getExpenseSummary(classId = null, academicYear = null) {
    try {
      const year = academicYear ? academicYear.replace(/-/g, '_') : await this.getAcademicYear();
      
      let students = [];
      if (classId) {
        const result = await fetchDocuments('students', {
          filters: [['class_id', '==', classId]],
          limitCount: 50
        });
        students = result.documents || [];
      } else {
        const result = await fetchDocuments('students', { limitCount: 500 });
        students = result.documents || [];
      }

      let totalRequired = 0;
      let totalPaid = 0;
      let totalRemaining = 0;
      let fullyPaidCount = 0;
      let partiallyPaidCount = 0;
      let unpaidCount = 0;

      for (const student of students) {
        const expenseId = `${student.id}_${year}`;
        try {
          const expense = await fetchDocument('expenses', expenseId);
          if (expense) {
            const requiredAmount = expense.required_amount ?? 0;
            const paidAmount = expense.paid_amount ?? 0;
            
            totalRequired += requiredAmount;
            totalPaid += paidAmount;
            
            // إصلاح #20: استخدام ?? بدلاً من ||
            const remaining = expense.remaining_amount 
              ?? (requiredAmount - paidAmount) 
              ?? 0;
            
            totalRemaining += Math.max(0, remaining);

            if (remaining <= 0) fullyPaidCount++;
            else if (paidAmount > 0) partiallyPaidCount++;
            else unpaidCount++;
          }
        } catch (e) {
          // تجاهل الطلاب بدون مصروفات
        }
      }

      return {
        totalStudents: students.length,
        totalRequired,
        totalPaid,
        totalRemaining,
        fullyPaidCount,
        partiallyPaidCount,
        unpaidCount,
        collectionRate: totalRequired > 0 ? ((totalPaid / totalRequired) * 100).toFixed(1) : 0
      };

    } catch (error) {
      console.error('❌ فشل جلب ملخص المصروفات:', error.message);
      return {
        totalStudents: 0,
        totalRequired: 0,
        totalPaid: 0,
        totalRemaining: 0,
        fullyPaidCount: 0,
        partiallyPaidCount: 0,
        unpaidCount: 0,
        collectionRate: 0
      };
    }
  }
}

const adminExpenses = new AdminExpensesManager();

export { AdminExpensesManager, adminExpenses };

console.log('📦 Admin Expenses Manager: جاهز | الإصدار 2.1');
console.log('ℹ️ السنة الدراسية تُجلب تلقائياً من الإعدادات');
console.log('ℹ️ تم إصلاح حساب remainingAmount باستخدام ??');