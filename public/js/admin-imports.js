(() => {
  const uploadForm = document.querySelector('[data-import-upload-form]');

  if (uploadForm) {
    const fileInput = uploadForm.querySelector('[data-import-upload-input]');
    const chooseButton = uploadForm.querySelector('[data-import-upload-button]');
    const fileNameInput = uploadForm.querySelector('[data-import-upload-name]');
    const submitButton = uploadForm.querySelector('[data-import-upload-submit]');

    if (fileInput && chooseButton && fileNameInput && submitButton) {
      chooseButton.addEventListener('click', () => {
        fileInput.click();
      });

      fileInput.addEventListener('change', () => {
        const selectedFile = fileInput.files && fileInput.files.length > 0 ? fileInput.files[0] : null;
        const maintenanceMode = submitButton.dataset.importUploadMaintenance === 'true';
        fileNameInput.value = selectedFile ? selectedFile.name : '';
        submitButton.disabled = !selectedFile || maintenanceMode;
      });
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

    if (!selectedOption || fileSelect.dataset.previewOnChange !== 'true') {
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
