(() => {
  "use strict";
  const STORAGE_KEY = "erdella-logistica-partes-v1";
  const STORAGE_BACKUP_KEY = "erdella-logistica-partes-respaldo-v1";
  const AUTH_KEY = "erdella-logistica-autorizado-v1";
  const LAST_WORKER_KEY = "erdella-logistica-ultimo-trabajador-v1";
  const DRAFT_KEY = "erdella-logistica-borrador-v1";
  const WORKERS_KEY = "erdella-logistica-trabajadores-v1";
  const VEHICLES_KEY = "erdella-logistica-camiones-v1";
  const CLOUD_DEVICE_KEY = "erdella-logistica-dispositivo-v1";
  const CLOUD_DELETIONS_KEY = "erdella-logistica-borrados-pendientes-v1";
  const ACCESS_USER = "logistica";
  const ACCESS_PASSWORD_HASH = "7907a88d77f29a7681a0dc6c89157ea3f45959944436301085c8a34a46fe4a77";
  const ADMIN_USER = "iurdana";
  const ADMIN_PASSWORD_HASH = "4c3aada37cf7fd3819b2da502a15f78f7ce5a2ce6d584b630344ff00dffc74ac";
  const TASK_OPTIONS = ["Varios", "Eroski tiendas", "Elorrio", "AN", "Castellana", "Eroski Jundiz", "Eroski Zubieta", "Transito"];
  function selectSavedTask(select, value, service = false) {
    select.querySelector("option[data-legacy-task]")?.remove();
    if (value && !TASK_OPTIONS.includes(value) && ![...select.options].some(option => option.value === value)) {
      const option = new Option(value, value);
      option.hidden = true;
      option.dataset.legacyTask = "";
      select.add(option);
    }
    select.value = service && value === "Varios" ? "" : (value || "");
  }
  const FIREBASE_CONFIG = {
    apiKey: "AIzaSyBjT_49FR1Fxq6kuph4n8L2SGje1WxYxJs",
    authDomain: "partes-trabajo-erdella.firebaseapp.com",
    databaseURL: "https://partes-trabajo-erdella-default-rtdb.europe-west1.firebasedatabase.app",
    projectId: "partes-trabajo-erdella",
    storageBucket: "partes-trabajo-erdella.firebasestorage.app",
    messagingSenderId: "466779972722",
    appId: "1:466779972722:web:14db41bbe079d869408eeb"
  };
  const $ = (id) => document.getElementById(id);
  const form = $("workForm");
  const fields = {
    id: $("recordId"), date: $("date"), worker: $("worker"), vehicle: $("vehicle"),
    task: $("task"), taskOther: $("taskOther"), startTime: $("startTime"), endTime: $("endTime"),
    startKm: $("startKm"), endKm: $("endKm"), notes: $("notes")
  };
  let deferredInstallPrompt = null;
  let adminUnlocked = false;
  let sharedWorkers = null;
  let sharedVehicles = null;
  let catalogRefreshPromise = null;
  let lastCatalogRefresh = 0;
  let restoringDraft = false;
  let cloudUser = null;
  let cloudReadyPromise = null;
  let draftSyncTimer = null;
  let cloudSyncPromise = null;

  async function hashPassword(value) {
    const data = new TextEncoder().encode(value);
    const digest = await crypto.subtle.digest("SHA-256", data);
    return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
  }

  function unlockApp() {
    document.body.classList.remove("auth-locked");
    $("loginScreen").hidden = true;
  }
  function initializeAccess() {
    if (localStorage.getItem(AUTH_KEY) === "si") { unlockApp(); return; }
    $("loginScreen").hidden = false;
    $("loginForm").addEventListener("submit", async event => {
      event.preventDefault();
      const passwordHash = await hashPassword($("loginPassword").value);
      const valid = $("loginUser").value.trim().toLowerCase() === ACCESS_USER && passwordHash === ACCESS_PASSWORD_HASH;
      if (!valid) {
        $("loginError").textContent = "Usuario o contraseña incorrectos.";
        $("loginError").hidden = false;
        $("loginPassword").value = "";
        $("loginPassword").focus();
        return;
      }
      localStorage.setItem(AUTH_KEY, "si");
      unlockApp();
    });
  }

  const readRecords = () => {
    for (const key of [STORAGE_KEY, STORAGE_BACKUP_KEY]) {
      try {
        const value = JSON.parse(localStorage.getItem(key));
        if (Array.isArray(value)) return value;
      } catch {}
    }
    return [];
  };
  function writeRecords(records) {
    const serialized = JSON.stringify(records);
    const previous = localStorage.getItem(STORAGE_KEY);
    if (previous) localStorage.setItem(STORAGE_BACKUP_KEY, previous);
    localStorage.setItem(STORAGE_KEY, serialized);
    localStorage.setItem(STORAGE_BACKUP_KEY, serialized);
  }

  function setCloudStatus(text, error = false) {
    const box = $("cloudStatus");
    if (!box) return;
    box.textContent = text;
    box.style.background = error ? "#fff1cf" : "#dff3e4";
    box.style.color = error ? "#704b00" : "#155d2c";
  }

  function cloudDeviceName() {
    return localStorage.getItem(LAST_WORKER_KEY) || fields.worker.value || "Dispositivo sin identificar";
  }
  const cloudRecordKey = id => String(id).replace(/[.#$\[\]/]/g, "_");
  function pendingCloudDeletions() {
    try { return JSON.parse(localStorage.getItem(CLOUD_DELETIONS_KEY)) || []; }
    catch { return []; }
  }
  function rememberCloudDeletion(id) {
    localStorage.setItem(CLOUD_DELETIONS_KEY, JSON.stringify([...new Set([...pendingCloudDeletions(), id])]));
  }
  function initializeCloudSync() {
    if (cloudReadyPromise) return cloudReadyPromise;
    cloudReadyPromise = new Promise(resolve => {
      if (!window.firebase?.auth || !window.firebase?.database) { resolve(null); return; }
      try {
        const app = firebase.apps.length ? firebase.app() : firebase.initializeApp(FIREBASE_CONFIG);
        const auth = app.auth();
        auth.setPersistence(firebase.auth.Auth.Persistence.LOCAL).catch(() => {});
        const stop = auth.onAuthStateChanged(async user => {
          if (!user) {
            try { await auth.signInAnonymously(); }
            catch (error) { console.warn("No se pudo iniciar la sincronización.", error); resolve(null); }
            return;
          }
          stop();
          cloudUser = user;
          localStorage.setItem(CLOUD_DEVICE_KEY, user.uid);
          resolve(user);
          syncExistingRecords().catch(error => {
            setCloudStatus("Guardado en el móvil. La copia en la nube está pendiente.", true);
            console.warn("La copia en la nube está pendiente.", error);
          });
        }, error => {
          console.warn("No se pudo iniciar la sincronización.", error);
          resolve(null);
        });
      } catch (error) {
        console.warn("La sincronización no está disponible.", error);
        resolve(null);
      }
    });
    return cloudReadyPromise;
  }
  async function updateCloudMetadata() {
    const user = cloudUser || await initializeCloudSync();
    if (!user) return false;
    await firebase.database().ref(`logisticaDevices/${user.uid}/metadata`).update({
      name: cloudDeviceName(),
      lastSeen: firebase.database.ServerValue.TIMESTAMP
    });
    return true;
  }
  async function syncRecord(record) {
    const user = cloudUser || await initializeCloudSync();
    if (!user) return false;
    await firebase.database().ref(`logisticaDevices/${user.uid}`).update({
      [`records/${cloudRecordKey(record.id)}`]: record,
      draft: null,
      "metadata/name": record.worker || cloudDeviceName(),
      "metadata/lastSeen": firebase.database.ServerValue.TIMESTAMP
    });
    return true;
  }

  async function syncDraft(draft) {
    const user = cloudUser || await initializeCloudSync();
    if (!user) return false;
    await firebase.database().ref(`logisticaDevices/${user.uid}`).update({
      draft: { ...draft, savedAt: firebase.database.ServerValue.TIMESTAMP },
      "metadata/name": draft.worker || cloudDeviceName(),
      "metadata/lastSeen": firebase.database.ServerValue.TIMESTAMP
    });
    return true;
  }

  function scheduleDraftSync(draft) {
    clearTimeout(draftSyncTimer);
    draftSyncTimer = setTimeout(() => {
      syncDraft(draft).catch(error => {
        setCloudStatus("Borrador guardado en el móvil; copia en nube pendiente.", true);
        console.warn("El borrador queda pendiente de sincronizar.", error);
      });
    }, 700);
  }
  async function removeCloudRecord(id) {
    const user = cloudUser || await initializeCloudSync();
    if (!user) return false;
    await firebase.database().ref(`logisticaDevices/${user.uid}/records/${cloudRecordKey(id)}`).remove();
    localStorage.setItem(CLOUD_DELETIONS_KEY, JSON.stringify(pendingCloudDeletions().filter(item => item !== id)));
    await updateCloudMetadata();
    return true;
  }
  async function syncExistingRecords() {
    if (cloudSyncPromise) return cloudSyncPromise;
    cloudSyncPromise = (async () => {
    const user = cloudUser || await initializeCloudSync();
    if (!user) {
      setCloudStatus("Guardado local activo. No se pudo conectar con la copia en la nube.", true);
      return false;
    }
    setCloudStatus("Comprobando la copia de seguridad…");
    const deviceRef = firebase.database().ref(`logisticaDevices/${user.uid}`);
    const snapshot = await deviceRef.once("value");
    const remote = snapshot.val() || {};
    const deleted = new Set(pendingCloudDeletions());
    const merged = new Map();
    const keepNewest = record => {
      if (!record?.id || deleted.has(record.id)) return;
      const previous = merged.get(record.id);
      if (!previous || String(record.updatedAt || "") >= String(previous.updatedAt || "")) merged.set(record.id, record);
    };
    readRecords().forEach(keepNewest);
    Object.values(remote.records || {}).forEach(keepNewest);
    const mergedRecords = [...merged.values()];
    writeRecords(mergedRecords);

    if (!localStorage.getItem(DRAFT_KEY) && remote.draft && typeof remote.draft === "object") {
      const { savedAt, ...remoteDraft } = remote.draft;
      localStorage.setItem(DRAFT_KEY, JSON.stringify(remoteDraft));
      const formIsEmpty = !fields.task.value && !fields.startTime.value && !fields.endTime.value && !fields.startKm.value && !fields.endKm.value;
      if (formIsEmpty) restoreDraft();
    }
    const updates = {};
    for (const record of mergedRecords) updates[`records/${cloudRecordKey(record.id)}`] = record;
    for (const id of pendingCloudDeletions()) updates[`records/${cloudRecordKey(id)}`] = null;
    const localDraft = localStorage.getItem(DRAFT_KEY);
    if (localDraft) {
      try { updates.draft = { ...JSON.parse(localDraft), savedAt: firebase.database.ServerValue.TIMESTAMP }; }
      catch {}
    }
    updates["metadata/name"] = cloudDeviceName();
    updates["metadata/lastSeen"] = firebase.database.ServerValue.TIMESTAMP;
    await deviceRef.update(updates);
    localStorage.removeItem(CLOUD_DELETIONS_KEY);
    renderRecords();
    setCloudStatus("Copia de seguridad en la nube al día.");
    return true;
    })();
    try { return await cloudSyncPromise; }
    finally { cloudSyncPromise = null; }
  }
  const normalizeWorker = (value) => String(value ?? "").trim().replace(/\s+/g, " ").toUpperCase();
  const normalizePlate = (value) => String(value ?? "").trim().replace(/\s+/g, "").toUpperCase();
  const normalizeWorkers = (workers) => [...new Set((Array.isArray(workers) ? workers : []).map(normalizeWorker).filter(Boolean))].sort((a, b) => a.localeCompare(b, "es"));
  function readWorkers() {
    if (sharedWorkers) return [...sharedWorkers];
    try {
      const saved = JSON.parse(localStorage.getItem(WORKERS_KEY));
      if (Array.isArray(saved)) return normalizeWorkers(saved);
    } catch {}
    return normalizeWorkers(APP_DATA.workers);
  }
  function normalizeVehicles(vehicles) {
    const unique = new Map();
    for (const vehicle of vehicles) {
      const plate = normalizePlate(Array.isArray(vehicle) ? vehicle[0] : vehicle?.plate);
      if (plate) unique.set(plate, [plate, ""]);
    }
    return [...unique.values()].sort((a, b) => a[0].localeCompare(b[0], "es"));
  }
  function readVehicles() {
    if (sharedVehicles) return sharedVehicles.map(vehicle => [...vehicle]);
    try {
      const saved = JSON.parse(localStorage.getItem(VEHICLES_KEY));
      if (Array.isArray(saved)) return normalizeVehicles(saved);
    } catch {}
    return normalizeVehicles(APP_DATA.vehicles);
  }
  function applyCatalog(workers, vehicles) {
    sharedWorkers = normalizeWorkers(workers);
    sharedVehicles = normalizeVehicles(vehicles);
    localStorage.setItem(WORKERS_KEY, JSON.stringify(sharedWorkers));
    localStorage.setItem(VEHICLES_KEY, JSON.stringify(sharedVehicles));
    fillWorkerSelect();
    fillVehicleSelect();
    renderAdminWorkers();
    renderAdminVehicles();
  }
  function refreshSharedCatalog() {
    if (catalogRefreshPromise) return catalogRefreshPromise;
    lastCatalogRefresh = Date.now();
    catalogRefreshPromise = Promise.resolve().then(() => {
      applyCatalog(readWorkers(), readVehicles());
      return true;
    }).finally(() => { catalogRefreshPromise = null; });
    return catalogRefreshPromise;
  }
  async function saveSharedCatalog(workers, vehicles) {
    if (!adminUnlocked) throw new Error("AUTH");
    const cleanWorkers = normalizeWorkers(workers);
    const cleanVehicles = normalizeVehicles(vehicles);
    applyCatalog(cleanWorkers, cleanVehicles);
  }
  const writeWorkers = (workers) => saveSharedCatalog(workers, readVehicles());
  const writeVehicles = (vehicles) => saveSharedCatalog(readWorkers(), vehicles);
  const formatDate = (value) => new Intl.DateTimeFormat("es-ES", { dateStyle: "medium", timeZone: "UTC" }).format(new Date(`${value}T00:00:00Z`));

  function minutesBetween(start, end) {
    if (!start || !end) return null;
    const [sh, sm] = start.split(":").map(Number);
    const [eh, em] = end.split(":").map(Number);
    let minutes = (eh * 60 + em) - (sh * 60 + sm);
    if (minutes < 0) minutes += 24 * 60;
    return minutes;
  }
  function durationLabel(start, end) {
    const minutes = minutesBetween(start, end);
    if (minutes === null) return "—";
    return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, "0")} min`;
  }
  function distanceValue(start, end) {
    if (start === "" || end === "") return null;
    return Number(end) - Number(start);
  }
  function refreshCalculations() {
    let startTime = fields.startTime.value;
    let endTime = fields.endTime.value;
    let distance = distanceValue(fields.startKm.value, fields.endKm.value);
    if (fields.task.value === "Varios") {
      const lines = serviceLines();
      startTime = lines[0]?.querySelector(".service-start-time").value || "";
      endTime = lines.at(-1)?.querySelector(".service-end-time").value || "";
      const distances = lines.map(line => distanceValue(
        line.querySelector(".service-start-km").value,
        line.querySelector(".service-end-km").value
      ));
      distance = distances.length && distances.every(value => value !== null)
        ? distances.reduce((total, value) => total + value, 0)
        : null;
    }
    $("duration").textContent = durationLabel(startTime, endTime);
    $("distance").textContent = distance === null ? "—" : `${distance.toLocaleString("es-ES")} km`;
    $("distance").style.color = distance !== null && distance < 0 ? "#a61b1b" : "";
  }
  function todayLocal() {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  }
  function resetForm(clearDraft = true) {
    if (clearDraft) localStorage.removeItem(DRAFT_KEY);
    form.reset();
    fields.id.value = "";
    fields.date.value = todayLocal();
    const lastWorker = localStorage.getItem(LAST_WORKER_KEY);
    if (lastWorker && readWorkers().includes(lastWorker)) fields.worker.value = lastWorker;
    toggleTaskOther();
    toggleMultipleService();
    $("formTitle").textContent = "Nueva jornada";
    $("formMessage").hidden = true;
    refreshCalculations();
  }
  function draftServiceLine(line) {
    return {
      vehicle: line.querySelector(".service-vehicle").value,
      task: line.querySelector(".service-task").value,
      taskOther: line.querySelector(".service-task-other").value,
      startTime: line.querySelector(".service-start-time").value,
      endTime: line.querySelector(".service-end-time").value,
      startKm: line.querySelector(".service-start-km").value,
      endKm: line.querySelector(".service-end-km").value
    };
  }
  function saveDraft() {
    if (restoringDraft) return;
    const draft = Object.fromEntries(Object.entries(fields).map(([key, field]) => [key, field.value]));
    draft.services = fields.task.value === "Varios" ? serviceLines().map(draftServiceLine) : [];
    localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
    scheduleDraftSync(draft);
  }
  function restoreDraft() {
    let draft;
    try { draft = JSON.parse(localStorage.getItem(DRAFT_KEY)); }
    catch { return false; }
    if (!draft || typeof draft !== "object") return false;
    restoringDraft = true;
    try {
      form.reset();
      fields.id.value = draft.id || "";
      fields.date.value = draft.date || todayLocal();
      fields.worker.value = draft.worker || "";
      selectSavedTask(fields.task, draft.task);
      fields.taskOther.value = draft.taskOther || "";
      fields.notes.value = draft.notes || "";
      toggleTaskOther();
      toggleMultipleService();
      if (fields.task.value === "Varios") {
        $("serviceLines").replaceChildren();
        const services = Array.isArray(draft.services) ? draft.services : [];
        if (services.length) services.forEach(createServiceLine); else createServiceLine();
      } else {
        fields.vehicle.value = draft.vehicle || "";
        fields.startTime.value = draft.startTime || "";
        fields.endTime.value = draft.endTime || "";
        fields.startKm.value = draft.startKm ?? "";
        fields.endKm.value = draft.endKm ?? "";
      }
      $("formTitle").textContent = fields.id.value ? "Editar jornada" : "Nueva jornada";
      $("formMessage").hidden = true;
      refreshCalculations();
      return true;
    } finally {
      restoringDraft = false;
    }
  }
  function fillWorkerSelect() {
    const selected = fields.worker.value || localStorage.getItem(LAST_WORKER_KEY) || "";
    fields.worker.replaceChildren(new Option("Seleccionar trabajador…", ""));
    const workers = readWorkers();
    for (const worker of workers) fields.worker.add(new Option(worker, worker));
    if (workers.includes(selected)) fields.worker.value = selected;
  }
  function fillVehicleSelect() {
    const selected = fields.vehicle.value;
    fields.vehicle.replaceChildren(new Option("Seleccionar matrícula…", ""));
    const vehicles = readVehicles();
    for (const [plate] of vehicles) fields.vehicle.add(new Option(plate, plate));
    if (vehicles.some(([plate]) => plate === selected)) fields.vehicle.value = selected;
    document.querySelectorAll(".service-vehicle").forEach(select => fillServiceVehicleSelect(select, select.value));
  }
  function fillSelects() {
    fillWorkerSelect();
    fillVehicleSelect();
  }
  const serviceLines = () => [...$("serviceLines").querySelectorAll(".service-line")];
  function fillServiceVehicleSelect(select, selected = "") {
    select.replaceChildren(new Option("Seleccionar matrícula…", ""));
    for (const [plate] of readVehicles()) select.add(new Option(plate, plate));
    if ([...select.options].some(option => option.value === selected)) select.value = selected;
  }
  function renumberServiceLines() {
    serviceLines().forEach((line, index) => {
      line.querySelector(".service-line-title").textContent = `Servicio adicional ${index + 1}`;
    });
  }
  function updateServiceTaskOther(line) {
    const task = line.querySelector(".service-task");
    const other = line.querySelector(".service-task-other");
    const show = task.value === "Otros";
    line.querySelector(".service-task-other-label").hidden = !show;
    other.required = show;
    if (!show) other.value = "";
  }
  function updateServiceCalculations(line) {
    const startTime = line.querySelector(".service-start-time").value;
    const endTime = line.querySelector(".service-end-time").value;
    const startKm = line.querySelector(".service-start-km").value;
    const endKm = line.querySelector(".service-end-km").value;
    line.querySelector(".service-duration").textContent = durationLabel(startTime, endTime);
    const distance = distanceValue(startKm, endKm);
    const distanceBox = line.querySelector(".service-distance");
    distanceBox.textContent = distance === null ? "—" : `${distance.toLocaleString("es-ES")} km`;
    distanceBox.style.color = distance !== null && distance < 0 ? "#a61b1b" : "";
    refreshCalculations();
  }
  function readServiceLine(line) {
    const task = line.querySelector(".service-task").value;
    return {
      vehicle: line.querySelector(".service-vehicle").value,
      task,
      taskOther: task === "Otros" ? line.querySelector(".service-task-other").value.trim() : "",
      startTime: line.querySelector(".service-start-time").value,
      endTime: line.querySelector(".service-end-time").value,
      startKm: Number(line.querySelector(".service-start-km").value),
      endKm: Number(line.querySelector(".service-end-km").value)
    };
  }
  function createServiceLine(data = {}) {
    const line = $("serviceLineTemplate").content.firstElementChild.cloneNode(true);
    const vehicle = line.querySelector(".service-vehicle");
    fillServiceVehicleSelect(vehicle, data.vehicle || "");
    selectSavedTask(line.querySelector(".service-task"), data.task, true);
    line.querySelector(".service-task-other").value = data.taskOther || "";
    line.querySelector(".service-start-time").value = data.startTime || "";
    line.querySelector(".service-end-time").value = data.endTime || "";
    line.querySelector(".service-start-km").value = data.startKm ?? "";
    line.querySelector(".service-end-km").value = data.endKm ?? "";
    line.querySelector(".service-task").addEventListener("change", () => updateServiceTaskOther(line));
    line.querySelectorAll(".service-start-time, .service-end-time, .service-start-km, .service-end-km")
      .forEach(input => input.addEventListener("input", () => updateServiceCalculations(line)));
    line.querySelector(".remove-service-line").addEventListener("click", () => {
      line.remove();
      if (!serviceLines().length && fields.task.value === "Varios") createServiceLine();
      renumberServiceLines();
      refreshCalculations();
      saveDraft();
    });
    $("serviceLines").append(line);
    updateServiceTaskOther(line);
    updateServiceCalculations(line);
    renumberServiceLines();
    return line;
  }
  function showAdminMessage(text, error = false) {
    const box = $("adminMessage");
    box.textContent = text;
    box.style.background = error ? "#fde4e4" : "#dff3e4";
    box.style.color = error ? "#8b1717" : "#155d2c";
    box.hidden = false;
  }
  function renderAdminWorkers() {
    if (!adminUnlocked) return;
    const workers = readWorkers();
    const list = $("adminWorkerList");
    list.replaceChildren();
    $("adminWorkerCount").textContent = `${workers.length} trabajadores`;
    for (const worker of workers) {
      const row = document.createElement("div");
      row.className = "admin-worker-row";
      const name = document.createElement("span");
      name.textContent = worker;
      const remove = document.createElement("button");
      remove.className = "danger-button";
      remove.type = "button";
      remove.textContent = "Quitar";
      remove.addEventListener("click", async () => {
        if (!confirm(`¿Quitar a ${worker} de la lista?`)) return;
        try {
          remove.disabled = true;
          await writeWorkers(workers.filter(item => item !== worker));
          showAdminMessage("Trabajador eliminado de este dispositivo.");
        } catch { showAdminMessage("No se pudo guardar el cambio.", true); }
        finally { remove.disabled = false; }
      });
      row.append(name, remove);
      list.append(row);
    }
  }
  function renderAdminVehicles() {
    if (!adminUnlocked) return;
    const vehicles = readVehicles();
    const list = $("adminVehicleList");
    list.replaceChildren();
    $("adminVehicleCount").textContent = `${vehicles.length} camiones`;
    for (const [plate] of vehicles) {
      const row = document.createElement("div");
      row.className = "admin-worker-row";
      const name = document.createElement("span");
      name.textContent = plate;
      const remove = document.createElement("button");
      remove.className = "danger-button";
      remove.type = "button";
      remove.textContent = "Quitar";
      remove.addEventListener("click", async () => {
        if (!confirm(`¿Quitar el camión ${plate} de la lista?`)) return;
        try {
          remove.disabled = true;
          await writeVehicles(vehicles.filter(([itemPlate]) => itemPlate !== plate));
          showAdminMessage("Camión eliminado de este dispositivo.");
        } catch { showAdminMessage("No se pudo guardar el cambio.", true); }
        finally { remove.disabled = false; }
      });
      row.append(name, remove);
      list.append(row);
    }
  }
  function switchView(view) {
    const admin = view === "admin";
    $("workView").hidden = admin;
    $("adminView").hidden = !admin;
    $("workTabButton").classList.toggle("active", !admin);
    $("adminTabButton").classList.toggle("active", admin);
    if (admin && adminUnlocked) {
      renderAdminWorkers();
      renderAdminVehicles();
    }
    if (admin && !adminUnlocked) $("adminUser").focus();
  }
  function currentRecord() {
    const multiple = fields.task.value === "Varios";
    const services = multiple ? serviceLines().map(readServiceLine) : [];
    return {
      id: fields.id.value || (crypto.randomUUID?.() || `${Date.now()}-${Math.random()}`),
      date: fields.date.value,
      worker: fields.worker.value,
      vehicle: multiple ? "" : fields.vehicle.value,
      task: fields.task.value,
      taskOther: fields.task.value === "Otros" ? fields.taskOther.value.trim() : "",
      startTime: multiple ? (services[0]?.startTime || "") : fields.startTime.value,
      endTime: multiple ? (services.at(-1)?.endTime || "") : fields.endTime.value,
      startKm: multiple ? null : Number(fields.startKm.value),
      endKm: multiple ? null : Number(fields.endKm.value),
      services,
      notes: fields.notes.value.trim(),
      updatedAt: new Date().toISOString()
    };
  }
  function validateRecord(record) {
    if (record.task === "Otros" && !record.taskOther) return "Especifica la tarea en el campo Otros.";
    if (record.task !== "Varios" && record.endKm < record.startKm) return "Los kilómetros finales no pueden ser menores que los iniciales.";
    if (record.task !== "Varios" && minutesBetween(record.startTime, record.endTime) === 0) return "La hora de inicio y la hora de fin no pueden ser iguales.";
    if (record.task === "Varios" && !record.services.length) return "Añade al menos una línea de servicio.";
    for (let index = 0; index < record.services.length; index++) {
      const service = record.services[index];
      const label = `servicio adicional ${index + 1}`;
      if (service.task === "Otros" && !service.taskOther) return `Especifica la tarea del ${label}.`;
      if (service.endKm < service.startKm) return `Los kilómetros finales del ${label} no pueden ser menores que los iniciales.`;
      if (minutesBetween(service.startTime, service.endTime) === 0) return `La hora de inicio y fin del ${label} no pueden ser iguales.`;
    }
    return "";
  }
  function showMessage(text, error = false) {
    const box = $("formMessage");
    box.textContent = text;
    box.style.background = error ? "#fde4e4" : "#dff3e4";
    box.style.color = error ? "#8b1717" : "#155d2c";
    box.hidden = false;
  }
  async function saveRecord(event) {
    event.preventDefault();
    if (!form.reportValidity()) return;
    const record = currentRecord();
    const problem = validateRecord(record);
    if (problem) { showMessage(problem, true); return; }
    const records = readRecords();
    const index = records.findIndex(item => item.id === record.id);
    if (index >= 0) records[index] = record; else records.push(record);
    try {
      writeRecords(records);
    } catch (error) {
      showMessage("No se pudo guardar el parte en este móvil. No cierres la aplicación y vuelve a intentarlo.", true);
      console.error("Falló el guardado local.", error);
      return;
    }
    localStorage.setItem(LAST_WORKER_KEY, record.worker);
    resetForm();
    renderRecords();
    showMessage(index >= 0 ? "Parte actualizado en el móvil. Copiando en la nube…" : "Parte guardado en el móvil. Copiando en la nube…");
    try {
      await syncRecord(record);
      setCloudStatus("Copia de seguridad en la nube al día.");
      showMessage(index >= 0 ? "Parte actualizado en el móvil y en la nube." : "Parte guardado en el móvil y en la nube.");
    } catch (error) {
      setCloudStatus("Guardado en el móvil. La copia en la nube está pendiente.", true);
      showMessage("Parte guardado en el móvil. Se copiará en la nube al recuperar conexión.", true);
      console.warn("El parte queda pendiente de sincronizar.", error);
    }
  }
  function editRecord(id) {
    const record = readRecords().find(item => item.id === id);
    if (!record) return;
    for (const key of Object.keys(fields)) if (key in record) fields[key].value = record[key];
    fields.id.value = record.id;
    $("formTitle").textContent = "Editar jornada";
    const previousTask = record.task || record.route || "";
    selectSavedTask(fields.task, previousTask);
    fields.taskOther.value = record.taskOther || "";
    toggleTaskOther();
    toggleMultipleService();
    if (fields.task.value === "Varios") {
      $("serviceLines").replaceChildren();
      const savedServices = Array.isArray(record.services) ? record.services : (record.extraService ? [record.extraService] : []);
      if (savedServices.length) savedServices.forEach(createServiceLine); else createServiceLine();
    }
    refreshCalculations();
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
  function deleteRecord(id) {
    if (!confirm("¿Eliminar este parte de trabajo?")) return;
    writeRecords(readRecords().filter(item => item.id !== id));
    rememberCloudDeletion(id);
    removeCloudRecord(id).catch(error => console.warn("La eliminación queda pendiente de sincronizar.", error));
    renderRecords();
  }
  async function shareRecord(id) {
    const r = readRecords().find(item => item.id === id);
    if (!r) return;
    const extras = Array.isArray(r.services) ? r.services : (r.extraService ? [r.extraService] : []);
    const distance = r.task === "Varios"
      ? extras.reduce((total, service) => total + (service.endKm - service.startKm), 0)
      : r.endKm - r.startKm;
    const vehicleLabel = r.task === "Varios" ? "Varias matrículas" : r.vehicle;
    let text = `Parte ${formatDate(r.date)}\n${r.worker}\n${vehicleLabel}\nTarea: ${taskLabel(r)}\n${r.startTime}–${r.endTime} (${durationLabel(r.startTime, r.endTime)})\n${distance} km`;
    extras.forEach((service, index) => {
      text += `\n\nServicio adicional ${index + 1}\n${service.vehicle}\nTarea: ${taskLabel(service)}\n${service.startTime}–${service.endTime} (${durationLabel(service.startTime, service.endTime)})\n${service.endKm - service.startKm} km`;
    });
    if (navigator.share) await navigator.share({ title: "Parte de trabajo", text }).catch(() => {});
    else await navigator.clipboard.writeText(text).then(() => alert("Parte copiado al portapapeles."));
  }
  function filteredRecords() {
    const month = $("monthFilter").value;
    return readRecords()
      .filter(item => !month || item.date.startsWith(month))
      .sort((a, b) => b.date.localeCompare(a.date) || b.updatedAt.localeCompare(a.updatedAt));
  }
  function renderRecords() {
    const records = filteredRecords();
    const list = $("recordsList");
    list.replaceChildren();
    $("recordCount").textContent = `${records.length} ${records.length === 1 ? "registro" : "registros"}`;
    $("emptyState").hidden = records.length > 0;
    for (const record of records) {
      const card = $("recordTemplate").content.firstElementChild.cloneNode(true);
      card.dataset.id = record.id;
      card.querySelector(".record-date").textContent = formatDate(record.date);
      card.querySelector(".record-worker").textContent = record.worker;
      card.querySelector(".record-plate").textContent = record.task === "Varios" ? "Varias matrículas" : record.vehicle;
      card.querySelector(".record-task").textContent = `Tarea: ${taskLabel(record)}`;
      card.querySelector(".record-time").textContent = `${record.startTime}–${record.endTime}`;
      card.querySelector(".record-duration").textContent = durationLabel(record.startTime, record.endTime);
      const extras = Array.isArray(record.services) ? record.services : (record.extraService ? [record.extraService] : []);
      const distance = record.task === "Varios"
        ? extras.reduce((total, service) => total + (service.endKm - service.startKm), 0)
        : record.endKm - record.startKm;
      card.querySelector(".record-km").textContent = `${distance.toLocaleString("es-ES")} km`;
      if (extras.length) {
        const extraBox = card.querySelector(".record-extra");
        extraBox.hidden = false;
        extraBox.querySelector(".record-extra-detail").textContent = extras.map((service, index) =>
          `${index + 1}. ${service.vehicle} · ${taskLabel(service)} · ${service.startTime}–${service.endTime} · ${(service.endKm - service.startKm).toLocaleString("es-ES")} km`
        ).join("\n");
      }
      card.querySelector(".record-notes").textContent = record.notes;
      card.querySelector(".edit-record").addEventListener("click", () => editRecord(record.id));
      card.querySelector(".share-record").addEventListener("click", () => shareRecord(record.id));
      card.querySelector(".delete-record").addEventListener("click", () => deleteRecord(record.id));
      list.append(card);
    }
  }
  function exportExcel() {
    const records = filteredRecords();
    if (!records.length) { alert("No hay registros para exportar."); return; }
    XlsxExporter.download(records, `partes_trabajo_${$("monthFilter").value || "todos"}.xlsx`, minutesBetween);
  }

  function taskLabel(record) {
    if (record.task === "Otros") return record.taskOther || "Otros";
    return record.task || record.route || "";
  }
  function toggleTaskOther() {
    const show = fields.task.value === "Otros";
    $("taskOtherLabel").hidden = !show;
    fields.taskOther.required = show;
    if (!show) fields.taskOther.value = "";
  }
  function toggleMultipleService() {
    const show = fields.task.value === "Varios";
    $("multipleService").hidden = !show;
    document.querySelectorAll(".main-detail-field").forEach(label => { label.hidden = show; });
    fields.vehicle.required = !show;
    if (show) fields.vehicle.value = "";
    [fields.startTime, fields.endTime, fields.startKm, fields.endKm].forEach(input => {
      input.required = !show;
      if (show) input.value = "";
    });
    if (show && !serviceLines().length) createServiceLine();
    if (!show) $("serviceLines").replaceChildren();
    refreshCalculations();
  }

  initializeAccess();
  initializeCloudSync();
  fillSelects();
  if (!restoreDraft()) resetForm(false);
  renderRecords();
  refreshSharedCatalog(true);
  form.addEventListener("submit", saveRecord);
  form.addEventListener("input", saveDraft);
  form.addEventListener("change", saveDraft);
  $("newButton").addEventListener("click", resetForm);
  [fields.startTime, fields.endTime, fields.startKm, fields.endKm].forEach(el => el.addEventListener("input", refreshCalculations));
  fields.task.addEventListener("change", () => { toggleTaskOther(); toggleMultipleService(); });
  $("addServiceLine").addEventListener("click", () => { createServiceLine(); saveDraft(); });
  $("monthFilter").addEventListener("change", renderRecords);
  $("clearFilter").addEventListener("click", () => { $("monthFilter").value = ""; renderRecords(); });
  $("exportButton").addEventListener("click", exportExcel);
  $("workTabButton").addEventListener("click", () => switchView("work"));
  $("adminTabButton").addEventListener("click", () => switchView("admin"));
  $("adminLoginForm").addEventListener("submit", async event => {
    event.preventDefault();
    const passwordHash = await hashPassword($("adminPassword").value);
    if ($("adminUser").value.trim().toLowerCase() !== ADMIN_USER || passwordHash !== ADMIN_PASSWORD_HASH) {
      $("adminLoginError").textContent = "Usuario o clave incorrectos.";
      $("adminLoginError").hidden = false;
      $("adminPassword").value = "";
      $("adminPassword").focus();
      return;
    }
    const button = event.submitter;
    button.disabled = true;
    button.textContent = "Conectando…";
    try {
      adminUnlocked = true;
      await refreshSharedCatalog(true);
      $("adminLoginError").hidden = true;
      $("adminLoginForm").hidden = true;
      $("adminManager").hidden = false;
      renderAdminWorkers();
      renderAdminVehicles();
      showAdminMessage("Administración abierta. Los cambios se guardarán en este dispositivo.");
    } catch (error) {
      $("adminLoginError").textContent = "No se pudo abrir la administración.";
      $("adminLoginError").hidden = false;
      $("adminPassword").value = "";
      $("adminPassword").focus();
    } finally {
      button.disabled = false;
      button.textContent = "Entrar en administración";
    }
  });
  $("adminWorkerForm").addEventListener("submit", async event => {
    event.preventDefault();
    const worker = normalizeWorker($("adminWorkerName").value);
    const workers = readWorkers();
    if (workers.includes(worker)) { showAdminMessage("Ese trabajador ya está en la lista.", true); return; }
    const button = event.submitter;
    try {
      button.disabled = true;
      await writeWorkers([...workers, worker]);
      $("adminWorkerName").value = "";
      showAdminMessage("Trabajador añadido en este dispositivo.");
    } catch { showAdminMessage("No se pudo guardar el cambio.", true); }
    finally { button.disabled = false; }
  });
  $("resetWorkersButton").addEventListener("click", async () => {
    if (!confirm("¿Restablecer la lista original de trabajadores?")) return;
    try {
      $("resetWorkersButton").disabled = true;
      await writeWorkers(APP_DATA.workers);
      showAdminMessage("Lista original de trabajadores restablecida en este dispositivo.");
    } catch { showAdminMessage("No se pudo guardar el cambio.", true); }
    finally { $("resetWorkersButton").disabled = false; }
  });
  $("adminVehicleForm").addEventListener("submit", async event => {
    event.preventDefault();
    const plate = normalizePlate($("adminVehiclePlate").value);
    const vehicles = readVehicles();
    if (!plate) { showAdminMessage("Escribe una matrícula.", true); return; }
    if (vehicles.some(([itemPlate]) => itemPlate === plate)) {
      showAdminMessage("Esa matrícula ya está en la lista.", true);
      return;
    }
    const button = event.submitter;
    try {
      button.disabled = true;
      await writeVehicles([...vehicles, [plate, ""]]);
      $("adminVehiclePlate").value = "";
      showAdminMessage("Camión añadido en este dispositivo.");
    } catch { showAdminMessage("No se pudo guardar el cambio.", true); }
    finally { button.disabled = false; }
  });
  $("resetVehiclesButton").addEventListener("click", async () => {
    if (!confirm("¿Restablecer la lista original de camiones?")) return;
    try {
      $("resetVehiclesButton").disabled = true;
      await writeVehicles(APP_DATA.vehicles);
      showAdminMessage("Lista original de camiones restablecida en este dispositivo.");
    } catch { showAdminMessage("No se pudo guardar el cambio.", true); }
    finally { $("resetVehiclesButton").disabled = false; }
  });

  window.addEventListener("focus", () => { refreshSharedCatalog(); syncExistingRecords().catch(() => {}); });
  window.addEventListener("pageshow", () => { refreshSharedCatalog(true); syncExistingRecords().catch(() => {}); });
  window.addEventListener("online", () => syncExistingRecords().catch(() => {}));
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      refreshSharedCatalog();
      syncExistingRecords().catch(() => {});
    } else {
      saveDraft();
    }
  });

  const installButton = $("installButton");
  installButton.hidden = window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
  window.addEventListener("beforeinstallprompt", event => {
    event.preventDefault();
    deferredInstallPrompt = event;
    installButton.hidden = false;
  });
  window.addEventListener("appinstalled", () => {
    deferredInstallPrompt = null;
    installButton.hidden = true;
  });
  installButton.addEventListener("click", async () => {
    const prompt = deferredInstallPrompt;
    deferredInstallPrompt = null;
    if (prompt) {
      try {
        await prompt.prompt();
        const choice = await prompt.userChoice;
        if (choice.outcome === "accepted") installButton.hidden = true;
        return;
      } catch {}
    }
    alert("En Android, abre este enlace en Chrome. Pulsa ⋮, luego «Añadir a pantalla de inicio» y elige «Instalar» si aparece. Si solo ves «Crear acceso directo», puedes añadir un icono sin instalar la app.");
  });
  if ("serviceWorker" in navigator) window.addEventListener("load", () => navigator.serviceWorker.register("sw.js"));
})();
