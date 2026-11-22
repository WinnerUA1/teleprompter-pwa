(async () => {
    const label = document.querySelector("#offlineStatus");
    const currentVersion = document.querySelector('meta[name="app-version"]').content;
    document.querySelector("#appVersion").textContent = `Версія ${currentVersion}`;
    if (!window.isSecureContext || !("serviceWorker" in navigator)) {
        label.textContent = "Автономний режим недоступний. Відкрийте через HTTPS із довіреним сертифікатом.";
        return;
    }
    try {
        const registration = await navigator.serviceWorker.register("./sw.js", { updateViaCache: "none" });
        const showUpdate = (worker = registration.waiting) => {
            const show = version => {
                label.textContent = `Доступне оновлення${version ? ` ${version}` : ""}. Натисни «Оновити», щоб встановити.`;
            };
            show();
            if (worker) {
                const channel = new MessageChannel();
                const timeout = setTimeout(() => channel.port1.close(), 3000);
                channel.port1.onmessage = event => {
                    clearTimeout(timeout);
                    channel.port1.close();
                    show(event.data.version);
                };
                worker.postMessage({ type: "GET_VERSION" }, [channel.port2]);
            }
        };
        registration.addEventListener("updatefound", () => {
            const installing = registration.installing;
            if (installing) installing.addEventListener("statechange", () => {
                if (installing.state === "installed" && navigator.serviceWorker.controller) showUpdate(installing);
            });
        });
        const worker = registration.installing || registration.waiting;
        if (!registration.active && worker) {
            await new Promise((resolve, reject) => {
                const check = () => {
                    if (worker.state === "activated") resolve();
                    if (worker.state === "redundant") reject(new Error("Не вдалося зберегти всі файли"));
                };
                worker.addEventListener("statechange", check);
                check();
            });
        }
        await navigator.serviceWorker.ready;
        // ready resolves only after the shell has been cached and activated.
        const showReady = () => {
            if (registration.waiting) {
                showUpdate();
                return;
            }
            const installed = window.matchMedia("(display-mode: standalone)").matches || navigator.standalone;
            label.textContent = installed
                ? "Готово до роботи без мережі."
                : "Додай на Початковий екран і відкрий з іконки для роботи без мережі.";
        };
        if (navigator.serviceWorker.controller) showReady();
        else {
            label.textContent = "Файли збережено. Завершуємо підготовку автономного режиму…";
            navigator.serviceWorker.addEventListener("controllerchange", showReady, { once: true });
            if (navigator.serviceWorker.controller) showReady();
        }
    } catch (error) {
        label.textContent = `Не вдалося зберегти автономну версію. Перевірте довіру до HTTPS-сертифіката й оновіть сторінку. (${error.message})`;
    }
})();
