/* ===========================
   SCHOOLHUB PRO - ADMIN GALLERY MANAGER
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
  getServerTimestamp,
  uploadFile,
  deleteFile,
  getFileURL
} from './firebase-config.js';

import { 
  showToast, 
  showConfirm,
  formatDateArabic,
  isValidFileType,
  isValidFileSize
} from './utils.js';

import { cacheManager, CACHE_CONFIG } from './cache-manager.js';

const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/jpg'];
const MAX_IMAGE_SIZE_MB = 5;

class AdminGalleryManager {
  constructor() {
    this.currentAlbum = null;
  }

  async getAlbums(options = {}) {
    const limitCount = options.limit || 20;

    try {
      const result = await fetchDocuments('albums', {
        orderByField: 'createdAt',
        orderDirection: 'desc',
        limitCount: limitCount
      });

      return result.documents || [];
    } catch (error) {
      console.error('❌ فشل جلب الألبومات:', error.message);
      throw error;
    }
  }

  async getAlbum(albumId) {
    try {
      return await fetchDocument('albums', albumId);
    } catch (error) {
      console.error('❌ فشل جلب الألبوم:', error.message);
      throw error;
    }
  }

  async createAlbum(data) {
    try {
      if (!data.title || !data.title.trim()) {
        throw new Error('اسم الألبوم مطلوب');
      }

      const album = {
        title: data.title.trim(),
        description: data.description || '',
        cover_image: data.cover_image || null,
        image_count: 0,
        createdAt: getServerTimestamp(),
        updatedAt: getServerTimestamp()
      };

      const albumId = await saveDocument('albums', null, album, false);

      try {
        await incrementField('counters', 'stats', 'total_albums', 1);
      } catch (e) {}

      cacheManager.invalidate(CACHE_CONFIG.keys.public_albums);
      cacheManager.invalidateAdminCache();

      showToast('تم إنشاء الألبوم بنجاح 📸', 'success');
      return albumId;

    } catch (error) {
      showToast(error.message || 'فشل إنشاء الألبوم', 'error');
      throw error;
    }
  }

  async updateAlbum(albumId, data) {
    try {
      await updateDocument('albums', albumId, {
        ...data,
        updatedAt: getServerTimestamp()
      });

      cacheManager.invalidate(CACHE_CONFIG.keys.public_albums);
      cacheManager.invalidateAdminCache();
      showToast('تم تحديث الألبوم ✅', 'success');

    } catch (error) {
      showToast('فشل تحديث الألبوم', 'error');
      throw error;
    }
  }

  async deleteAlbum(albumId) {
    try {
      const album = await this.getAlbum(albumId);
      if (!album) throw new Error('الألبوم غير موجود');

      const confirmed = await showConfirm(
        `هل أنت متأكد من حذف ألبوم "${album.title}" وجميع صوره؟ لا يمكن التراجع.`,
        'تأكيد الحذف',
        'نعم، احذف الكل',
        'إلغاء'
      );

      if (!confirmed) return;

      const imagesResult = await fetchDocuments(`albums/${albumId}/images`, {
        orderByField: 'order',
        limitCount: 100
      });

      const images = imagesResult.documents || [];

      for (const image of images) {
        try {
          await deleteFile(`albums/${albumId}/${image.fileName || image.id}`);
        } catch (e) {
          console.warn('⚠️ فشل حذف الصورة من التخزين:', e.message);
        }
      }

      for (const image of images) {
        await removeDocument(`albums/${albumId}/images`, image.id);
      }

      await removeDocument('albums', albumId);

      try {
        await incrementField('counters', 'stats', 'total_albums', -1);
      } catch (e) {}

      cacheManager.invalidate(CACHE_CONFIG.keys.public_albums);
      cacheManager.invalidateAdminCache();

      showToast('تم حذف الألبوم بنجاح 🗑️', 'success');

    } catch (error) {
      showToast(error.message || 'فشل حذف الألبوم', 'error');
      throw error;
    }
  }

  async getAlbumImages(albumId, options = {}) {
    const limitCount = options.limit || 30;

    try {
      const result = await fetchDocuments(`albums/${albumId}/images`, {
        orderByField: 'order',
        orderDirection: 'asc',
        limitCount: limitCount
      });

      return result.documents || [];
    } catch (error) {
      console.error('❌ فشل جلب الصور:', error.message);
      throw error;
    }
  }

  async uploadImage(albumId, file, onProgress = null) {
    try {
      if (!file) throw new Error('لم يتم اختيار ملف');

      if (!isValidFileType(file, ALLOWED_IMAGE_TYPES)) {
        throw new Error('نوع الملف غير مدعوم. الأنواع المسموحة: JPEG, PNG, WebP');
      }

      if (!isValidFileSize(file, MAX_IMAGE_SIZE_MB)) {
        throw new Error(`حجم الملف كبير جداً. الحد الأقصى: ${MAX_IMAGE_SIZE_MB} ميجابايت`);
      }

      const timestamp = Date.now();
      const fileName = `${timestamp}_${file.name}`;
      const path = `albums/${albumId}/${fileName}`;

      const downloadURL = await uploadFile(path, file, (progress) => {
        if (onProgress) onProgress(progress);
      });

      const images = await this.getAlbumImages(albumId);
      const nextOrder = images.length + 1;

      const imageData = {
        url: downloadURL,
        fileName: fileName,
        order: nextOrder,
        size: file.size,
        contentType: file.type,
        createdAt: getServerTimestamp()
      };

      const imageId = await saveDocument(`albums/${albumId}/images`, null, imageData, false);

      const imageCount = images.length + 1;
      let coverImage = null;

      const album = await this.getAlbum(albumId);
      if (!album?.cover_image) {
        coverImage = downloadURL;
      }

      await updateDocument('albums', albumId, {
        image_count: imageCount,
        ...(coverImage ? { cover_image: coverImage } : {}),
        updatedAt: getServerTimestamp()
      });

      cacheManager.invalidate(CACHE_CONFIG.keys.public_albums);
      cacheManager.invalidateAdminCache();

      return { imageId, url: downloadURL, order: nextOrder };

    } catch (error) {
      showToast(error.message || 'فشل رفع الصورة', 'error');
      throw error;
    }
  }

  async uploadMultipleImages(albumId, files, onProgress = null) {
    try {
      if (!files || files.length === 0) {
        throw new Error('لم يتم اختيار ملفات');
      }

      const results = { success: [], failed: [] };
      const total = files.length;
      let completed = 0;

      for (const file of files) {
        try {
          const result = await this.uploadImage(albumId, file);
          results.success.push(result);
        } catch (e) {
          results.failed.push({ fileName: file.name, error: e.message });
        }
        completed++;
        if (onProgress) {
          onProgress(Math.round((completed / total) * 100));
        }
      }

      showToast(
        `تم رفع ${results.success.length} صورة` + 
        (results.failed.length > 0 ? ` (فشل: ${results.failed.length})` : ''),
        results.failed.length === 0 ? 'success' : 'warning'
      );

      return results;

    } catch (error) {
      showToast(error.message || 'فشل رفع الصور', 'error');
      throw error;
    }
  }

  async deleteImage(albumId, imageId) {
    try {
      const image = await fetchDocument(`albums/${albumId}/images`, imageId);
      if (!image) throw new Error('الصورة غير موجودة');

      const confirmed = await showConfirm(
        'هل أنت متأكد من حذف هذه الصورة؟',
        'تأكيد الحذف',
        'نعم، احذف',
        'إلغاء'
      );

      if (!confirmed) return;

      if (image.fileName) {
        try {
          await deleteFile(`albums/${albumId}/${image.fileName}`);
        } catch (e) {
          console.warn('⚠️ فشل حذف الملف من التخزين:', e.message);
        }
      }

      await removeDocument(`albums/${albumId}/images`, imageId);

      const remainingImages = await this.getAlbumImages(albumId);
      const newCount = remainingImages.length;
      let newCover = null;

      if (newCount > 0) {
        newCover = remainingImages[0].url;
      }

      const album = await this.getAlbum(albumId);
      const wasCover = album?.cover_image === image.url;

      await updateDocument('albums', albumId, {
        image_count: newCount,
        ...(wasCover && newCover ? { cover_image: newCover } : {}),
        ...(newCount === 0 ? { cover_image: null } : {}),
        updatedAt: getServerTimestamp()
      });

      cacheManager.invalidate(CACHE_CONFIG.keys.public_albums);
      cacheManager.invalidateAdminCache();

      showToast('تم حذف الصورة بنجاح 🗑️', 'success');

    } catch (error) {
      showToast(error.message || 'فشل حذف الصورة', 'error');
      throw error;
    }
  }

  async setCoverImage(albumId, imageUrl) {
    try {
      await updateDocument('albums', albumId, {
        cover_image: imageUrl,
        updatedAt: getServerTimestamp()
      });

      cacheManager.invalidate(CACHE_CONFIG.keys.public_albums);
      cacheManager.invalidateAdminCache();

      showToast('تم تعيين صورة الغلاف ✅', 'success');

    } catch (error) {
      showToast('فشل تعيين صورة الغلاف', 'error');
      throw error;
    }
  }

  async reorderImages(albumId, imageIds) {
    try {
      for (let i = 0; i < imageIds.length; i++) {
        await updateDocument(`albums/${albumId}/images`, imageIds[i], {
          order: i + 1,
          updatedAt: getServerTimestamp()
        });
      }

      cacheManager.invalidate(CACHE_CONFIG.keys.public_albums);
      cacheManager.invalidateAdminCache();

      showToast('تم إعادة ترتيب الصور ✅', 'success');

    } catch (error) {
      showToast('فشل إعادة ترتيب الصور', 'error');
      throw error;
    }
  }
}

const adminGallery = new AdminGalleryManager();

export { AdminGalleryManager, adminGallery, ALLOWED_IMAGE_TYPES, MAX_IMAGE_SIZE_MB };

console.log('📦 Admin Gallery Manager: جاهز');