(() => {
  const uploadForm = document.querySelector('[data-import-upload-form]');

  if (uploadForm) {
    const fileInput = uploadForm.querySelector('[data-import-upload-input]');
    const chooseButton = uploadForm.querySelector('[data-import-upload-button]');
    const fileNameInput = uploadForm.querySelector('[data-import-upload-name]');
    const uploadSubmitButton = uploadForm.querySelector('[data-import-upload-submit]');
    const runSubmitButton = uploadForm.querySelector('[data-import-run-submit]');
    const submitStatus = uploadForm.querySelector('[data-import-submit-status]');
    const submitStatusText = uploadForm.querySelector('[data-import-submit-status-text]');
    const submitButtons = Array.from(uploadForm.querySelectorAll('button[type="submit"]'));
    let isSubmitting = false;

    const syncUploadControls = () => {
      const selectedFile = fileInput && fileInput.files && fileInput.files.length > 0 ? fileInput.files[0] : null;
      const uploadMaintenanceMode = uploadSubmitButton && uploadSubmitButton.dataset.importUploadMaintenance === 'true';
      const runMaintenanceMode = runSubmitButton && runSubmitButton.dataset.importRunMaintenance === 'true';
      const selectedImportImported = runSubmitButton && runSubmitButton.dataset.selectedImportImported === 'true';

      if (fileNameInput) {
        fileNameInput.value = selectedFile ? selectedFile.name : '';
      }

      if (isSubmitting) {
        return;
      }

      if (uploadSubmitButton) {
        uploadSubmitButton.disabled = !selectedFile || uploadMaintenanceMode;
      }

      if (runSubmitButton && selectedFile) {
        runSubmitButton.disabled = runMaintenanceMode;
      } else if (runSubmitButton && selectedImportImported) {
        runSubmitButton.disabled = true;
      }
    };

    uploadForm.addEventListener('submit', (event) => {
      if (isSubmitting) {
        event.preventDefault();
        return;
      }

      isSubmitting = true;
      const submitter = event.submitter;
      const isUploadOnly = submitter && submitter.matches('[data-import-upload-submit]');
      const selectedFile = fileInput && fileInput.files && fileInput.files.length > 0 ? fileInput.files[0] : null;
      const fileLabel = selectedFile ? ` “${selectedFile.name}”` : '';

      uploadForm.setAttribute('aria-busy', 'true');

      if (submitStatus) {
        submitStatus.classList.remove('d-none');
      }

      if (submitStatusText) {
        submitStatusText.textContent = isUploadOnly
          ? `Uploading${fileLabel} to the import inbox…`
          : `Uploading and importing${fileLabel || ' the selected inbox file'}…`;
      }

      submitButtons.forEach((button) => {
        button.disabled = true;
      });

      if (submitter) {
        submitter.innerHTML = '<span class="spinner-border spinner-border-sm me-2" aria-hidden="true"></span>Working…';
      }
    });

    if (fileInput && chooseButton) {
      chooseButton.addEventListener('click', () => {
        fileInput.click();
      });

      if (fileNameInput) {
        fileNameInput.addEventListener('click', () => {
          fileInput.click();
        });
      }

      fileInput.addEventListener('change', syncUploadControls);
      syncUploadControls();
    }
  }

  const form = document.querySelector('[data-import-form]');

  if (!form) {
    return;
  }

  const fileSelect = form.querySelector('select[name="file"]');
  const importFileIdInput = form.querySelector('input[name="importFileId"]');

  if (!fileSelect || !importFileIdInput) {
    return;
  }

  const getSelectedOption = () => fileSelect.options[fileSelect.selectedIndex] || null;

  const syncSelectedImportFileId = () => {
    const selectedOption = getSelectedOption();
    importFileIdInput.value = selectedOption ? (selectedOption.dataset.importFileId || '') : '';
    return selectedOption;
  };

  fileSelect.addEventListener('change', () => {
    const selectedOption = syncSelectedImportFileId();

    if (!selectedOption || !selectedOption.value || fileSelect.dataset.previewOnChange !== 'true') {
      return;
    }

    const params = new URLSearchParams({ importFileId: importFileIdInput.value });
    const fieldsToPreserve = ['assetId', 'interval', 'inputFormat', 'policy'];

    fieldsToPreserve.forEach((fieldName) => {
      const field = form.elements[fieldName];
      const queryName = fieldName === 'assetId' ? 'asset' : fieldName;

      if (field && field.value) {
        params.set(queryName, field.value);
      }
    });

    window.location.assign(`/admin/imports?${params.toString()}`);
  });

  syncSelectedImportFileId();
})();
