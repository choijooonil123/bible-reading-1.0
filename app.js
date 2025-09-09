/* 말씀읽기APP — Firebase 로그인/진도저장 + bible.json
   + 안드로이드 최적화 음성매칭
   + 마이크는 버튼으로만 ON/OFF
   + 절 완료시 절 버튼 색, 장 모두 완료시 장 버튼 색
   + 절 자동이동/장 자동이동(성공 처리)
   + "해당절읽음" 버튼 지원
   + 마이크 ON일 때 음성모드 변경 금지(라디오 없을 시 자동 무시)
*/
(() => {
  // ---------- PWA ----------
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("./sw.js", { scope: "./" })
        .then(reg => console.log("[SW] registered:", reg.scope))
        .catch(err => console.warn("[SW] register failed:", err));
    });
  }

  // ---------- Firebase ----------
  let auth, db, user;
  function initFirebase() {
    if (!window.firebaseConfig || typeof firebase === "undefined") {
      console.error("[Firebase] SDK/config 누락");
      return;
    }
    firebase.initializeApp(window.firebaseConfig);
    auth = firebase.auth();
    db   = firebase.firestore();
    console.log("[Firebase] 초기화 OK");
  }
  initFirebase();

  // ---------- Screens ----------
  const scrLogin = document.getElementById("screen-login");
  const scrApp   = document.getElementById("screen-app");
  function showScreen(name) {
    if (name === "login") { scrLogin?.classList.add("show"); scrApp?.classList.remove("show"); }
    else { scrApp?.classList.add("show"); scrLogin?.classList.remove("show"); }
  }

  // ---------- DOM ----------
  const els = {
    email: document.getElementById("email"),
    password: document.getElementById("password"),
    displayName: document.getElementById("displayName"),
    nickname: document.getElementById("nickname"),
    btnLogin: document.getElementById("btnLogin"),
    btnSignup: document.getElementById("btnSignup"),
    signedIn: document.getElementById("signedIn"),
    userName: document.getElementById("userName"),
    userPhoto: document.getElementById("userPhoto"),
    btnSignOut: document.getElementById("btnSignOut"),
    bookSelect: document.getElementById("bookSelect"),
    chapterGrid: document.getElementById("chapterGrid"),
    verseGrid: document.getElementById("verseGrid"),
    verseText: document.getElementById("verseText"),
    locLabel: document.getElementById("locLabel"),
    verseCount: document.getElementById("verseCount"),
    myStats: document.getElementById("myStats"),
    leaderList: document.getElementById("leaderList"),
    matrixModal: document.getElementById("matrixModal"),
    matrixWrap: document.getElementById("matrixWrap"),
    btnCloseMatrix: document.getElementById("btnCloseMatrix"),
    btnOpenMatrix: document.getElementById("btnOpenMatrix"),
    btnPrevVerse: document.getElementById("btnPrevVerse"),
    btnNextVerse: document.getElementById("btnNextVerse"),
    btnToggleMic: document.getElementById("btnToggleMic"),
    btnMarkRead: document.getElementById("btnMarkRead"),
    listenHint: document.getElementById("listenHint"),
    autoAdvance: document.getElementById("autoAdvance"),
    micBar: document.getElementById("micBar"),
    micDb: document.getElementById("micDb"),
  };

  // 모달이 닫혀있을 때는 클릭 차단
  if (els.matrixModal) els.matrixModal.style.pointerEvents = "none";

  // ---------- State ----------
  const BOOKS = window.BOOKS || [];
  const getBookByKo = (ko) => BOOKS.find(b => b.ko === ko);
  const IS_ANDROID = /Android/i.test(navigator.userAgent);
  const state = {
    bible: null, currentBookKo: null, currentChapter: null,
    verses: [], currentVerseIdx: 0,
    listening:false, recog:null,
    progress:{}, myStats:{versesRead:0,chaptersRead:0,last:{bookKo:null,chapter:null,verse:0}},
    ignoreUntilTs: 0, paintedPrefix: 0,
    verseDoneMap: {},
    // 하이라이트 정합성용 캐시
    charCumJamo: [],    // 각 화면 글자까지의 누적 자모 길이
    charJamoLens: [],   // 각 화면 글자의 자모 기여 길이
    // 누적 음성(자모) 버퍼
    heardJ: "",
    // 자동 이동 제어
    _advancing:false,
    // 🎚️ 약간 늦게 칠하기용 타이머
    paintTimer: null,
    pendingPaint: 0
  };

  // ---------- [DEBUG] 패널/로그 ----------
  const DEBUG_ON = localStorage.getItem('debugMatch') === '1'; // 토글 키
  let _dbgBox = null, _dbgBody = null, _dbgHead = null, _dbgRows = 0;

  function ensureDebugPanel(){
    if (!DEBUG_ON || _dbgBox) return;
    _dbgBox = document.createElement('div');
    _dbgBox.id = 'matchDebug';
    Object.assign(_dbgBox.style, {
      position:'fixed', right:'8px', bottom:'8px', maxWidth:'46vw', width:'420px',
      background:'rgba(0,0,0,0.75)', color:'#c8f7dc', font:'12px/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      border:'1px solid rgba(67,209,122,0.6)', borderRadius:'10px', boxShadow:'0 6px 20px rgba(0,0,0,0.35)',
      zIndex: 999999, backdropFilter:'blur(2px)'
    });
    _dbgHead = document.createElement('div');
    _dbgHead.textContent = '🎯 Match Debug (localStorage.debugMatch=1)';
    Object.assign(_dbgHead.style, { padding:'8px 10px', borderBottom:'1px solid rgba(67,209,122,0.3)', fontWeight:'700', color:'#9ff0b9' });

    _dbgBody = document.createElement('div');
    Object.assign(_dbgBody.style, { maxHeight:'40vh', overflow:'auto', padding:'8px 10px', whiteSpace:'pre-wrap' });

    // 상단 상태줄
    const status = document.createElement('div');
    status.id = 'matchStatus';
    Object.assign(status.style, { padding:'6px 10px', borderTop:'1px solid rgba(67,209,122,0.3)', fontSize:'11px', color:'#e3ffe5' });

    _dbgBox.appendChild(_dbgHead);
    _dbgBox.appendChild(_dbgBody);
    _dbgBox.appendChild(status);
    document.body.appendChild(_dbgBox);
  }

  function dbg(line){
    if (!DEBUG_ON) return;
    ensureDebugPanel();
    const row = document.createElement('div');
    row.textContent = line;
    _dbgBody.appendChild(row);
    _dbgRows++;
    // 너무 많아지면 위에서 삭제
    if (_dbgRows > 250) {
      _dbgBody.removeChild(_dbgBody.firstChild);
      _dbgRows--;
    }
    _dbgBody.scrollTop = _dbgBody.scrollHeight;
    // 콘솔도 함께
    console.debug('[MATCH]', line);
  }
  function dbgKV(obj){
    const line = Object.entries(obj).map(([k,v])=>`${k}=${typeof v==='number'?Number(v).toFixed(3):v}`).join('  |  ');
    dbg(line);
  }
  function dbgStatus(text){
    if (!DEBUG_ON) return;
    const status = document.getElementById('matchStatus');
    if (status) status.textContent = text;
  }
  // 페이지 로드 직후 준비
  if (DEBUG_ON) {
    // body가 아직 없을 수 있으니 약간 지연
    setTimeout(ensureDebugPanel, 0);
    dbg('🔧 Debug panel ON');
  }
  // --------------------------------------

  // ==== 매칭 엄격도: '엄격' | '보통' | '관대' (기본=보통) ====
  let MATCH_STRICTNESS = localStorage.getItem("matchStrictness") || "보통";
  window.setMatchStrictness = function(level){
    if(!["엄격","보통","관대"].includes(level)) return;
    MATCH_STRICTNESS = level;
    localStorage.setItem("matchStrictness", level);
    const hint = document.getElementById("listenHint");
    if (hint) hint.textContent = `음성매칭 엄격도: ${level}`;
    // 라디오 UI 동기화
    document.querySelectorAll('input[name=matchStrict]').forEach(r=>{
      r.checked = (r.value === level);
    });
    dbg(`[STRICT] set → ${level}`); // [DEBUG]
  };
  function needThresholdByLen(len){
    const base = (len<=30?0.80:(len<=60?0.78:0.75));
    const delta = (MATCH_STRICTNESS==="엄격"? +0.04 : MATCH_STRICTNESS==="관대"? -0.04 : 0);
    return Math.max(0.65, Math.min(0.92, base + delta));
  }
  function costsByStrictness(){
    if (MATCH_STRICTNESS==="엄격") return { subNear:0.38, subFar:1.00, del:0.60, ins:0.60 };
    if (MATCH_STRICTNESS==="관대") return { subNear:0.28, subFar:0.88, del:0.52, ins:0.52 };
    return { subNear:0.35, subFar:1.00, del:0.55, ins:0.55 };
  }
  function initStrictnessUI(){
    const radios = document.querySelectorAll('input[name=matchStrict]');
    if (!radios.length) return;
    radios.forEach(r=>{
      r.checked = (r.value === MATCH_STRICTNESS);
      r.addEventListener('change', ()=>{
        if (r.checked) window.setMatchStrictness(r.value);
      });
    });
    const hint = document.getElementById("listenHint");
    if (hint) hint.textContent = `음성매칭 엄격도: ${MATCH_STRICTNESS}`;
  }

  // ---------- bible.json ----------
  async function loadBible() {
    try {
      const res = await fetch("./bible.json", { cache: "no-cache" });
      if (!res.ok) throw new Error("bible.json not found");
      state.bible = await res.json();
      dbg('[BIBLE] loaded'); // [DEBUG]
    } catch (e) {
      console.error("[bible.json] 로딩 실패:", e);
      els.verseText && (els.verseText.textContent = "루트에 bible.json 파일이 필요합니다.");
      dbg('[BIBLE] load FAIL'); // [DEBUG]
    }
  }
  loadBible();
  initStrictnessUI(); // 👈 엄격도 UI 초기화

  // ---------- Auth UX ----------
  function mapAuthError(e) {
    const code = e?.code || "";
    if (code.includes("invalid-email")) return "이메일 형식이 올바르지 않습니다.";
    if (code.includes("email-already-in-use")) return "이미 가입된 이메일입니다. 로그인하세요.";
    if (code.includes("weak-password")) return "비밀번호를 6자 이상으로 입력하세요.";
    if (code.includes("operation-not-allowed")) return "이메일/비밀번호 로그인이 비활성화되어 있습니다. 콘솔에서 활성화해주세요.";
    if (code.includes("network-request-failed")) return "네트워크 오류가 발생했습니다. 인터넷 연결을 확인하세요.";
    return e?.message || "알 수 없는 오류가 발생했습니다.";
  }
  async function safeEnsureUserDoc(u, opts={}) {
    try { await ensureUserDoc(u, opts); } catch (e){ console.warn("[ensureUserDoc] 실패:", e); }
  }
  let busy=false;
  async function withBusy(btn, fn){
    if(busy) return;
    busy=true;
    const orig = btn?.textContent;
    if(btn){ btn.disabled=true; btn.textContent="처리 중…"; }
    try{ await fn(); } finally { busy=false; if(btn){ btn.disabled=false; btn.textContent=orig; } }
  }

  // ---------- 회원가입 / 로그인 / 로그아웃 ----------
  els.btnSignup?.addEventListener("click", () => withBusy(els.btnSignup, async () => {
    const email = (els.email.value || "").trim();
    const pw    = (els.password.value || "").trim();
    const name  = (els.displayName.value || "").trim();
    const nick  = (els.nickname?.value || "").trim();
    if (!email || !pw) { alert("이메일/비밀번호를 입력하세요."); return; }

    try {
      const cred = await auth.createUserWithEmailAndPassword(email, pw);
      user = cred.user;
      if (name) { await user.updateProfile({ displayName: name }); }
      await safeEnsureUserDoc(user, { nickname: nick });
      dbg('[AUTH] signup OK'); // [DEBUG]
    } catch (e) {
      console.error(e);
      alert("회원가입 실패: " + mapAuthError(e));
      dbg('[AUTH] signup FAIL'); // [DEBUG]
    }
  }));

  els.btnLogin?.addEventListener("click", () => withBusy(els.btnLogin, async () => {
    const email = (els.email.value || "").trim();
    const pw    = (els.password.value || "").trim();
    const name  = (els.displayName.value || "").trim();
    const nick  = (els.nickname?.value || "").trim();
    if (!email || !pw) { alert("이메일/비밀번호를 입력하세요."); return; }

    try {
      const cred = await auth.signInWithEmailAndPassword(email, pw);
      user = cred.user;
      if (name) { await user.updateProfile({ displayName: name }); }
      await safeEnsureUserDoc(user, { nickname: nick });
      dbg('[AUTH] login OK'); // [DEBUG]
    } catch (e) {
      console.error(e);
      alert("로그인 실패: " + mapAuthError(e));
      dbg('[AUTH] login FAIL'); // [DEBUG]
    }
  }));

  els.btnSignOut?.addEventListener("click", () => auth?.signOut());

  auth?.onAuthStateChanged(async (u) => {
    user = u;
    dbg(`[AUTH] state: ${!!u}`); // [DEBUG]
    if (!u) { showScreen("login"); clearAppUI(); return; }

    showScreen("app");
    els.signedIn?.classList.remove("hidden");
    els.userName && (els.userName.textContent = u.displayName || u.email || "사용자");
    if (els.userPhoto) {
      if (u.photoURL) { els.userPhoto.src = u.photoURL; els.userPhoto.classList.remove('hidden'); }
      else { els.userPhoto.classList.add('hidden'); }
    }

    try { await ensureUserDoc(u); } catch (e) {}
    try { await loadMyStats(); } catch (e) {}
    try { buildBookSelect(); } catch (e) {}
    try { loadLeaderboard(); } catch (e) {}
  });

  // ---------- Firestore helpers ----------
  async function ensureUserDoc(u, opts={}) {
    if (!db || !u) return;
    const data = {
      email: u.email || "",
      versesRead: firebase.firestore.FieldValue.increment(0),
      chaptersRead: firebase.firestore.FieldValue.increment(0),
      last: state.myStats.last || null,
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
    };
    if (opts.nickname && opts.nickname.trim()) data.nickname = opts.nickname.trim();
    await db.collection("users").doc(u.uid).set(data, { merge: true });
  }

  async function loadMyStats() {
    if (!db || !user) return;
    try {
      const snap = await db.collection("users").doc(user.uid).get();
      if (snap.exists) {
        const d = snap.data();
        state.myStats.versesRead = d.versesRead || 0;
        state.myStats.chaptersRead = d.chaptersRead || 0;
        state.myStats.last = d.last || { bookKo: null, chapter: null, verse: 0 };
        els.myStats && (els.myStats.textContent =
          `절 ${state.myStats.versesRead.toLocaleString()} · 장 ${state.myStats.chaptersRead.toLocaleString()}`);
      }
      dbg('[DB] stats loaded'); // [DEBUG]
    } catch (e) { dbg('[DB] stats FAIL'); }

    const p = {};
    try {
      const qs = await db.collection("users").doc(user.uid).collection("progress").get();
      qs.forEach(doc => { p[doc.id] = { readChapters: new Set((doc.data().readChapters) || []) }; });
      dbg('[DB] progress loaded'); // [DEBUG]
    } catch (e) { dbg('[DB] progress FAIL'); }
    state.progress = p;
  }

  async function saveLastPosition() {
    if (!db || !user) return;
    try {
      await db.collection("users").doc(user.uid).set({
        last: state.myStats.last,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
      dbg('[DB] last saved'); // [DEBUG]
    } catch (e) { dbg('[DB] last save FAIL'); }
  }

  async function markChapterDone(bookId, chapter) {
    if (!state.progress[bookId]) state.progress[bookId] = { readChapters: new Set() };
    state.progress[bookId].readChapters.add(chapter);
    if (db && user) {
      try {
        await db.collection("users").doc(user.uid).collection("progress").doc(bookId)
          .set({ readChapters: Array.from(state.progress[bookId].readChapters) }, { merge: true });
        await db.collection("users").doc(user.uid)
          .set({ chaptersRead: firebase.firestore.FieldValue.increment(1),
                 updatedAt: firebase.firestore.FieldValue.serverTimestamp() }, { merge: true });
        state.myStats.chaptersRead += 1;
        els.myStats && (els.myStats.textContent =
          `절 ${state.myStats.versesRead.toLocaleString()} · 장 ${state.myStats.chaptersRead.toLocaleString()}`);
        buildChapterGrid();
        buildMatrix();
        dbg('[DB] chapter done'); // [DEBUG]
      } catch (e) { dbg('[DB] chapter done FAIL'); }
    }
  }

  async function incVersesRead(n = 1) {
    state.myStats.versesRead += n;
    els.myStats && (els.myStats.textContent =
      `절 ${state.myStats.versesRead.toLocaleString()} · 장 ${state.myStats.chaptersRead.toLocaleString()}`);
    if (db && user) {
      try {
        await db.collection("users").doc(user.uid)
          .set({
            versesRead: firebase.firestore.FieldValue.increment(n),
            updatedAt: firebase.firestore.FieldValue.serverTimestamp()
          }, { merge: true });
        dbg(`[DB] verses +${n}`); // [DEBUG]
      } catch (e) { dbg('[DB] verses FAIL'); }
    }
  }

  // ---------- Book / Chapter / Verse ----------
  function clearAppUI() {
    els.bookSelect && (els.bookSelect.innerHTML = "");
    els.chapterGrid && (els.chapterGrid.innerHTML = "");
    els.verseGrid && (els.verseGrid.innerHTML = "");
    els.verseText && (els.verseText.textContent = "로그인 후 시작하세요.");
    els.leaderList && (els.leaderList.innerHTML = "");
    els.myStats && (els.myStats.textContent = "—");
    els.locLabel && (els.locLabel.textContent = "");
    els.verseCount && (els.verseCount.textContent = "");
    state.currentBookKo = null; state.currentChapter = null; state.verses = []; state.currentVerseIdx = 0;
  }

  function buildBookSelect() {
    if (!els.bookSelect) return;
    els.bookSelect.innerHTML = "";
    for (const b of BOOKS) {
      const opt = document.createElement("option");
      opt.value = b.ko; opt.textContent = b.ko;
      els.bookSelect.appendChild(opt);
    }
    const last = state.myStats?.last;
    if (last?.bookKo) {
      els.bookSelect.value = last.bookKo; state.currentBookKo = last.bookKo; buildChapterGrid();
      if (last.chapter) {
        selectChapter(last.chapter).then(() => {
          if (Number.isInteger(last.verse)) {
            state.currentVerseIdx = Math.max(0, (last.verse || 1) - 1); updateVerseText();
          }
        });
      }
    } else {
      els.bookSelect.value = BOOKS[0]?.ko || "";
      state.currentBookKo = els.bookSelect.value;
      buildChapterGrid();
    }
  }

  els.bookSelect?.addEventListener("change", () => {
    state.currentBookKo = els.bookSelect.value;
    state.currentChapter = null; state.verses = []; state.currentVerseIdx = 0;
    els.verseGrid && (els.verseGrid.innerHTML = "");
    els.verseText && (els.verseText.textContent = "장과 절을 선택하세요.");
    buildChapterGrid();
    state.myStats.last = { bookKo: state.currentBookKo, chapter: null, verse: 0 }; saveLastPosition();
  });

  // 장 버튼(원형) + 완료색 반영
  function buildChapterGrid() {
    const b = getBookByKo(state.currentBookKo);
    if (!b || !els.chapterGrid) return;
    els.chapterGrid.innerHTML = "";

    for (let i = 1; i <= b.ch; i++) {
      const btn = document.createElement("button");
      btn.type = "button"; // 폼 제출 방지
      const isDonePersist = state.progress[b.id]?.readChapters?.has(i);
      btn.className = "chip";
      btn.style.borderRadius = "9999px"; // 원형
      btn.textContent = i;

      // 세션 중 이 장의 절을 전부 완료했다면 done
      if (state.currentChapter === i) {
        const key = `${state.currentBookKo}#${i}`;
        const set = state.verseDoneMap[key];
        if (set && state.verses.length > 0 && set.size === state.verses.length) {
          btn.classList.add("done");
          btn.style.backgroundColor = "rgba(67,209,122,0.8)";
        }
      }
      if (isDonePersist) btn.classList.add("done");

      btn.addEventListener("click", (e) => {
        e.preventDefault();
        selectChapter(i);
      });
      if (state.currentChapter === i) btn.classList.add("active");
      els.chapterGrid.appendChild(btn);
    }
  }

  // 장 버튼 위임 클릭(동적 갱신/리스너 누락 대비)
  els.chapterGrid?.addEventListener("click", (e) => {
    const btn = e.target?.closest("button.chip");
    if (!btn || !els.chapterGrid.contains(btn)) return;
    const n = parseInt(btn.textContent, 10);
    if (Number.isFinite(n)) {
      e.preventDefault();
      e.stopPropagation();
      selectChapter(n);
    }
  });

  function keyForChapter(){ return `${state.currentBookKo}#${state.currentChapter}`; }

  // 절 버튼(원형) + 완료색 반영
  function buildVerseGrid() {
    if (!els.verseGrid) return;
    els.verseGrid.innerHTML = "";
    const key = keyForChapter();
    const doneSet = state.verseDoneMap[key] || new Set();

    for (let i = 1; i <= state.verses.length; i++) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "chip";
      btn.style.borderRadius = "9999px";
      btn.textContent = i;

      if (doneSet.has(i)) {
        btn.classList.add("readok");
        btn.style.backgroundColor = "rgba(67,209,122,0.6)";
      }

      btn.addEventListener("click", () => {
        state.currentVerseIdx = i - 1; updateVerseText();
        state.myStats.last.verse = i; saveLastPosition();
      });
      if (state.currentVerseIdx === i - 1) btn.classList.add("active");
      els.verseGrid.appendChild(btn);
    }
  }

  // ---------- 표시/매칭 ----------
  function buildCharToJamoCumMap(str){
    const jamoLens = [];
    const cum = [0];
    for (let i = 0; i < str.length; i++) {
      const ch = str[i];
      const rawJamo = decomposeJamo(ch).normalize("NFKC");
      const cleaned = rawJamo.replace(/[^\p{L}\p{N}]/gu, ""); // 문장부호/공백 제외
      const len = cleaned.length;
      jamoLens.push(len);
      cum.push(cum[cum.length - 1] + len);
    }
    state.charJamoLens = jamoLens;
    return cum;
  }

  function updateVerseText() {
    const v = state.verses[state.currentVerseIdx] || "";
    state.paintedPrefix = 0;
    state.heardJ = "";
    state.ignoreUntilTs = 0;
    state._advancing = false;
    if (state.paintTimer) { clearTimeout(state.paintTimer); state.paintTimer=null; }

    state.targetJ = normalizeToJamo(v, false);
    state.charCumJamo = buildCharToJamoCumMap(v);

    els.locLabel && (els.locLabel.textContent =
      `${state.currentBookKo} ${state.currentChapter}장 ${state.currentVerseIdx + 1}절`);
    if (els.verseText) {
      els.verseText.innerHTML = "";
      for (let i = 0; i < v.length; i++) {
        const s = document.createElement("span");
        s.textContent = v[i];
        s.style.color = "";
        els.verseText.appendChild(s);
      }
    }
    els.verseCount && (els.verseCount.textContent =
      `(${state.verses.length}절 중 ${state.currentVerseIdx + 1}절)`);
    if (els.verseGrid) {
      [...els.verseGrid.children].forEach((btn, idx) =>
        btn.classList.toggle("active", idx===state.currentVerseIdx));
    }

    // [DEBUG]
    dbg(`\n📖 Verse @${state.currentBookKo} ${state.currentChapter}:${state.currentVerseIdx+1}`);
    dbgKV({targetJ_len: state.targetJ.length, verse_len_chars: v.length});
  }

  function paintRead(prefixJamoLen){
    if (!els.verseText) return;
    const spans = els.verseText.childNodes;
    const cum   = state.charCumJamo || [];
    const lens  = state.charJamoLens || [];

    let k = 0;
    while (k < cum.length && cum[k] <= prefixJamoLen) k++;
    let charCount = Math.max(0, k - 1);

    if (prefixJamoLen === 0) {
      const firstNonZero = lens.findIndex(v => v > 0);
      if (firstNonZero > 0) charCount = 0;
    }

    for (let i=0;i<spans.length;i++){
      spans[i].style.color = (i < charCount) ? "#43d17a" : "";
      spans[i].classList?.remove("read");
    }
  }

  function schedulePaint(nextPrefix){
    state.pendingPaint = Math.max(state.pendingPaint, nextPrefix);
    if (state.paintTimer) clearTimeout(state.paintTimer);
    state.paintTimer = setTimeout(() => {
      const target = Math.max(state.paintedPrefix, state.pendingPaint);
      paintRead(target);
      // [DEBUG] 칠해진 길이 보고
      dbgKV({paint_commit_prefixJ: target, targetJ_len: (state.targetJ||'').length});
      state.paintedPrefix = target;
      state.pendingPaint = 0;
      state.paintTimer = null;
    }, 140);
  }

  function markVerseAsDone(verseIndex1Based) {
    const key = keyForChapter();
    if (!state.verseDoneMap[key]) state.verseDoneMap[key] = new Set();
    state.verseDoneMap[key].add(verseIndex1Based);

    if (els.verseGrid) {
      const btn = els.verseGrid.children[verseIndex1Based - 1];
      if (btn) {
        btn.classList.add("readok");
        btn.style.backgroundColor = "rgba(67,209,122,0.6)";
      }
    }

    if (state.verses.length > 0 && state.verseDoneMap[key].size === state.verses.length) {
      if (els.chapterGrid) {
        const idx = (state.currentChapter - 1);
        const chBtn = els.chapterGrid.children[idx];
        if (chBtn) {
          chBtn.classList.add("done");
          chBtn.style.backgroundColor = "rgba(67,209,122,0.8)";
        }
      }
    }
  }

  // ---------- 마이크 예열 ----------
  let primeStream;
  async function primeMicrophone() {
    if (primeStream && primeStream.getTracks().some(t=>t.readyState==="live")) return primeStream;
    try {
      primeStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: { ideal: 1 },
          sampleRate:   { ideal: 48000 },
          sampleSize:   { ideal: 16 },
          echoCancellation: { ideal: true },
          noiseSuppression: { ideal: true },
          autoGainControl:  { ideal: true }
        },
        video: false
      });
      if (window.AudioContext || window.webkitAudioContext) {
        try {
          const ac = new (window.AudioContext || window.webkitAudioContext)();
          if (ac.state === "suspended") await ac.resume();
          const src = ac.createMediaStreamSource(primeStream);
          const g = ac.createGain(); src.connect(g);
          await new Promise(r => setTimeout(r, 20));
          ac.close();
        } catch(_) {}
      }
      dbg('[MIC] primed'); // [DEBUG]
      return primeStream;
    } catch (e) {
      console.warn("[PrimeMic] 실패:", e);
      dbg('[MIC] prime FAIL'); // [DEBUG]
      return null;
    }
  }
  function releasePrimeMic() {
    try { if (primeStream) primeStream.getTracks().forEach(t=>t.stop()); } catch(_) {}
    primeStream = null;
    dbg('[MIC] released'); // [DEBUG]
  }

  // ---------- 한글 정규화/자모 ----------
  const CHO = ["ㄱ","ㄲ","ㄴ","ㄷ","ㄸ","ㄹ","ㅁ","ㅂ","ㅃ","ㅅ","ㅆ","ㅇ","ㅈ","ㅉ","ㅊ","ㅋ","ㅌ","ㅍ","ㅎ"];
  const JUNG = ["ㅏ","ㅐ","ㅑ","ㅒ","ㅓ","ㅔ","ㅕ","ㅖ","ㅗ","ㅘ","ㅙ","ㅚ","ㅛ","ㅜ","ㅝ","ㅞ","ㅟ","ㅠ","ㅡ","ㅢ","ㅣ"];
  const JONG = ["","ㄱ","ㄲ","ㄳ","ㄴ","ㄵ","ㄶ","ㄷ","ㄹ","ㄺ","ㄻ","ㄼ","ㄽ","ㄾ","ㄿ","ㅀ","ㅁ","ㅂ","ㅄ","ㅅ","ㅆ","ㅇ","ㅈ","ㅊ","ㅋ","ㅌ","ㅍ","ㅎ"];
  const S_BASE=0xAC00, L_COUNT=19, V_COUNT=21, T_COUNT=28, N_COUNT=V_COUNT*T_COUNT, S_COUNT=L_COUNT*N_COUNT;

  function decomposeJamo(s){
    const out=[];
    for (const ch of (s||"")){
      const code = ch.codePointAt(0);
      const sIndex = code - S_BASE;
      if (sIndex>=0 && sIndex<S_COUNT){
        const L = Math.floor(sIndex/N_COUNT);
        const V = Math.floor((sIndex%N_COUNT)/T_COUNT);
        const T = sIndex%T_COUNT;
        out.push(CHO[L], JUNG[V]); if (T) out.push(JONG[T]);
      } else out.push(ch);
    }
    return out.join("");
  }

  const NUM_KO = {"영":0,"공":0,"하나":1,"한":1,"둘":2,"두":2,"셋":3,"세":3,"넷":4,"네":4,"다섯":5,"여섯":6,"일곱":7,"여덟":8,"아홉":9,"열":10};
  function normalizeKoreanNumbers(s){
    return s
      .replace(/(열|한\s*십|일\s*십)/g,"십")
      .replace(/(한|일)\s*십/g,"십")
      .replace(/(둘|이)\s*십/g,"이십")
      .replace(/(셋|삼)\s*십/g,"삼십")
      .replace(/(넷|사)\s*십/g,"사십")
      .replace(/(다섯|오)\s*십/g,"오십")
      .replace(/(여섯|육)\s*십/g,"육십")
      .replace(/(일곱|칠)\s*십/g,"칠십")
      .replace(/(여덟|팔)\s*십/g,"팔십")
      .replace(/(아홉|구)\s*십/g,"구십")
      .replace(/십\s*(한|일)/g,"11").replace(/십\s*(둘|이)/g,"12")
      .replace(/십\s*(셋|삼)/g,"13").replace(/십\s*(넷|사)/g,"14")
      .replace(/십\s*(다섯|오)/g,"15").replace(/십\s*(여섯|육)/g,"16")
      .replace(/십\s*(일곱|칠)/g,"17").replace(/십\s*(여덟|팔)/g,"18")
      .replace(/십\s*(아홉|구)/g,"19")
      .replace(/^\s*십\s*$/g,"10");
  }

  const USE_PRONUN_HEUR = true; // '의'≈'에' 등
  function normalizeToJamo(s, forSpoken=false){
    let t = (s||"").normalize("NFKC").replace(/[“”‘’"'\u200B-\u200D`´^~]/g,"").toLowerCase();
    t = normalizeKoreanNumbers(t);
    if (forSpoken && USE_PRONUN_HEUR) t = t.replace(/의/g,"에");
    t = t.replace(/[^\p{L}\p{N} ]/gu," ").replace(/\s+/g," ").trim();
    return decomposeJamo(t).replace(/\s+/g,"");
  }

  // ---------- 매칭: 접두 커버리지 + 밴드 레벤슈타인 ----------
  const NEAR = new Set([
    "ㅐ,ㅔ","ㅔ,ㅐ","ㅚ,ㅙ","ㅚ,ㅞ","ㅙ,ㅞ",
    "ㅢ,ㅣ","ㅣ,ㅢ","ㅓ,ㅗ","ㅕ,ㅛ","ㅠ,ㅡ",
    "ㄴ,ㅇ","ㅇ,ㄴ","ㅂ,ㅍ","ㅍ,ㅂ","ㅂ,ㅁ","ㅁ,ㅂ",
    "ㄷ,ㅌ","ㅌ,ㄷ","ㅅ,ㅆ","ㅆ,ㅅ",
    "ㅎ,"," ,ㅎ"
  ]);
  function near(a,b){ return a===b || NEAR.has(`${a},${b}`); }

  function bandedEdit(target, spoken, band=10, subNear=0.35, subFar=1.0, del=0.55, ins=0.55){
    const n=target.length, m=spoken.length;
    let prev=new Float32Array(m+1), curr=new Float32Array(m+1);
    for(let j=0;j<=m;j++) prev[j]=j*ins;
    for(let i=1;i<=n;i++){
      const jStart=Math.max(1,i-band), jEnd=Math.min(m,i+band);
      curr[0]=i*del;
      for(let j=1;j<=m;j++){
        if(j<jStart||j>jEnd){ curr[j]=1e9; continue; }
        const cSub = prev[j-1] + (target[i-1]===spoken[j-1] ? 0 : (near(target[i-1], spoken[j-1])? subNear : subFar));
        const cDel = prev[j] + del;
        const cIns = curr[j-1] + ins;
        curr[j] = Math.min(cSub, cDel, cIns);
      }
      const t=prev; prev=curr; curr=t;
    }
    let best=prev[m];
    for(let j=Math.max(0,m-band); j<=m; j++) if(prev[j]<best) best=prev[j];
    return best;
  }

  function prefixCoverage(targetJ, spokenJ){
    const n = targetJ.length;
    if (!n || !spokenJ.length) return 0;

    const short=30, medium=60;
    const baseS=0.80, baseM=0.78, baseL=0.75;
    const delta = (MATCH_STRICTNESS==="엄격"? +0.04 : MATCH_STRICTNESS==="관대"? -0.04 : 0);
    const thrShort = Math.max(0.65, Math.min(0.92, baseS + delta));
    const thrMedium= Math.max(0.65, Math.min(0.92, baseM + delta));
    const thrLong  = Math.max(0.65, Math.min(0.92, baseL + delta));

    let bestI=0;
    const { subNear, subFar, del, ins } = costsByStrictness();

    for(let i=1;i<=n;i++){
      const slice = targetJ.slice(0,i);
      const band = Math.min(12, Math.max(6, Math.floor(i/8)));
      const ed = bandedEdit(slice, spokenJ, band, subNear, subFar, del, ins);
      const okRatio = 1 - (ed / Math.max(1,i));
      const thr = (i<=short)?thrShort : (i<=medium?thrMedium:thrLong);
      if (okRatio >= thr) bestI = i;
      if (i - bestI > 20) break;
    }
    return bestI;
  }

  function clamp(n, a, b){ return Math.max(a, Math.min(b, n)); }
  function bestPredictiveCoverage(targetJ, heardJ){
    const m = heardJ.length, n = targetJ.length;
    if (!m || !n) return { k: 0, score: 0 };
    const kMin = clamp(Math.floor(m * 0.6), 1, n);
    const kMax = clamp(Math.floor(m * 1.6) + 12, kMin, n);
    const { subNear, subFar, del, ins } = costsByStrictness();
    let bestK = 0, bestScore = 0;
    for (let k = kMin; k <= kMax; k++){
      const slice = targetJ.slice(0, k);
      const band = Math.min(16, Math.max(6, Math.floor(k / 8)));
      const ed = bandedEdit(slice, heardJ, band, subNear, subFar, del, ins);
      const score = 1 - (ed / Math.max(1, k));
      if (score > bestScore) { bestScore = score; bestK = k; }
    }
    return { k: bestK, score: bestScore };
  }

  // ---------- SpeechRecognition (Android 최적화 루프) ----------
  function supportsSR(){ return !!(window.SpeechRecognition || window.webkitSpeechRecognition); }
  function makeRecognizer(){
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return null;
    const r = new SR();
    r.lang = 'ko-KR';
    r.continuous = !IS_ANDROID;
    r.interimResults = !IS_ANDROID ? true : false;
    try { r.maxAlternatives = 4; } catch(_) {}
    return r;
  }

  let loopTimer=null;

  const ANDROID_WATCHDOG_MS  = 8500;
  const ANDROID_NORESULT_MS  = 7000;

  let watchdogTimer = null;
  let noResultTimer = null;
  let lastStartTs   = 0;
  let lastResultTs  = 0;

  function runRecognizerLoop(){
    if (!state.listening) return;
    const recog = makeRecognizer();
    if (!recog) {
      els.listenHint && (els.listenHint.innerHTML="⚠️ 음성인식 미지원(Chrome/Safari 권장)");
      alert("이 브라우저는 음성인식을 지원하지 않습니다.");
      stopListening();
      return;
    }
    state.recog = recog;

    recog.onresult = (evt)=>{
      lastResultTs = Date.now();
      if (noResultTimer) { clearTimeout(noResultTimer); noResultTimer = null; }
      noResultTimer = setTimeout(() => {
        if (!state.listening) return;
        try { state.recog && state.recog.abort?.(); } catch(_) {}
        runRecognizerLoop();
      }, ANDROID_NORESULT_MS);

      const v = state.verses[state.currentVerseIdx] || "";
      if (!v) return;
      if (Date.now() < state.ignoreUntilTs) return;

      const res = evt.results[evt.results.length-1]; if (!res) return;
      const tr = res[0]?.transcript || ""; if (!tr) return;

      const targetJ = state.targetJ || normalizeToJamo(v, false);
      const pieceJ  = normalizeToJamo(tr, true);

      // 누적
      if (res.isFinal || IS_ANDROID) {
        state.heardJ = (state.heardJ + pieceJ);
        const cap = targetJ.length * 3;
        if (state.heardJ.length > cap) state.heardJ = state.heardJ.slice(-cap);
      }

      const tmpHeard = state.heardJ + (res.isFinal ? "" : pieceJ);

      // 예측 커버리지
      const { k: predK, score } = bestPredictiveCoverage(targetJ, tmpHeard);
      // [DEBUG] 핵심 값 출력
      dbgKV({
        step:'result',
        heardJ_len: tmpHeard.length,
        targetJ_len: targetJ.length,
        score,
        predK,
        paintedPrefix: state.paintedPrefix,
        pendingPaint: state.pendingPaint
      });

      if (score >= 0.40) {
        const limited = Math.min(predK, state.paintedPrefix + 8, targetJ.length);
        schedulePaint(limited);
      }

      // 전부 칠해졌는지
      const fullyPainted = Math.max(state.paintedPrefix, state.pendingPaint) >= targetJ.length;
      // [DEBUG] 상태줄 갱신
      const overallRatio = state.paintedPrefix / Math.max(1, targetJ.length);
      dbgStatus(`ratio=${overallRatio.toFixed(3)}  fully=${fullyPainted}  painted=${state.paintedPrefix}/${targetJ.length}`);

      if (!state._advancing && fullyPainted) {
        state._advancing = true;
        dbg('✅ FULLY PAINTED → next verse'); // [DEBUG]
        setTimeout(() => {
          completeVerse(true);
          state._advancing = false;
        }, 100);
        return;
      }

      // 완화된 완료 판정(보조)
      const need = 0.60;
      const nearEnd = state.paintedPrefix >= targetJ.length - 10;
      if (overallRatio >= need && nearEnd && !state._advancing) {
        state._advancing = true;
        dbg('✅ NEAR-END THRESHOLD → next verse'); // [DEBUG]
        completeVerse(true);
        state._advancing = false;
      }
    };

    const restart = () => {
      if (!state.listening) return;
      if (watchdogTimer) { clearTimeout(watchdogTimer); watchdogTimer=null; }
      if (noResultTimer) { clearTimeout(noResultTimer); noResultTimer=null; }
      try {
        if (state.recog) {
          state.recog.onresult=null; state.recog.onend=null; state.recog.onerror=null;
          state.recog.abort?.();
        }
      } catch(_) {}
      loopTimer = setTimeout(runRecognizerLoop, 200);
    };
    recog.onend = restart;

    recog.onerror = (e)=>{
      const err = e?.error || "";
      dbg(`[SR] error: ${err}`); // [DEBUG]
      if (err === "aborted" || err === "no-speech") {
        if (!state.listening) return;
        if (watchdogTimer) { clearTimeout(watchdogTimer); watchdogTimer=null; }
        if (noResultTimer) { clearTimeout(noResultTimer); noResultTimer=null; }
        loopTimer = setTimeout(runRecognizerLoop, 300);
        return;
      }
      if (!state.listening) return;
      if (watchdogTimer) { clearTimeout(watchdogTimer); watchdogTimer=null; }
      if (noResultTimer) { clearTimeout(noResultTimer); noResultTimer=null; }
      loopTimer = setTimeout(runRecognizerLoop, 400);
      if (err === "not-allowed" || err === "service-not-allowed") {
        alert("마이크 권한이 필요합니다. 주소창 오른쪽 마이크 아이콘을 확인하세요.");
      }
    };

    try {
      lastStartTs  = Date.now();
      lastResultTs = lastStartTs;

      if (watchdogTimer) { clearTimeout(watchdogTimer); }
      watchdogTimer = setTimeout(() => {
        if (!state.listening) return;
        if (lastResultTs === lastStartTs) {
          try { state.recog && state.recog.abort?.(); } catch(_) {}
          runRecognizerLoop();
        }
      }, ANDROID_WATCHDOG_MS);

      if (noResultTimer) { clearTimeout(noResultTimer); }
      noResultTimer = setTimeout(() => {
        if (!state.listening) return;
        try { state.recog && state.recog.abort?.(); } catch(_) {}
        runRecognizerLoop();
      }, ANDROID_NORESULT_MS);

      recog.start();
      dbg('[SR] start'); // [DEBUG]
    } catch(e) {
      console.warn("recog.start 실패:", e);
      dbg('[SR] start FAIL'); // [DEBUG]
      if (watchdogTimer) { clearTimeout(watchdogTimer); watchdogTimer=null; }
      if (noResultTimer) { clearTimeout(noResultTimer); noResultTimer=null; }
      loopTimer = setTimeout(runRecognizerLoop, 150);
    }
  }

  async function startListening(showAlert=true){
    if (state.listening) return;
    if (!supportsSR()){
      els.listenHint && (els.listenHint.innerHTML="⚠️ 음성인식 미지원(Chrome/Safari 권장)");
      if (showAlert) alert("이 브라우저는 음성인식을 지원하지 않습니다.");
      return;
    }
    await primeMicrophone();

    state.paintedPrefix = 0;
    state.heardJ = "";
    state.ignoreUntilTs = 0;
    state._advancing = false;
    if (state.paintTimer) { clearTimeout(state.paintTimer); state.paintTimer=null; }
    state.listening = true;
    els.btnToggleMic && (els.btnToggleMic.textContent="⏹️");
    startMicLevel();

    refreshRecogModeLock();
    runRecognizerLoop();
    dbg('[SR] listening ON'); // [DEBUG]
  }

  function stopListening(resetBtn=true){
    state.listening=false;
    if (loopTimer) { clearTimeout(loopTimer); loopTimer=null; }
    if (state.recog){
      try{ state.recog.onresult=null; state.recog.onend=null; state.recog.onerror=null; state.recog.abort?.(); }catch(_){}
      try{ state.recog.stop?.(); }catch(_){}
    }
    if (watchdogTimer) { clearTimeout(watchdogTimer); watchdogTimer=null; }
    if (noResultTimer) { clearTimeout(noResultTimer); noResultTimer=null; }
    if (state.paintTimer) { clearTimeout(state.paintTimer); state.paintTimer=null; }

    if (resetBtn && els.btnToggleMic) els.btnToggleMic.textContent="🎙️";
    stopMicLevel();
    releasePrimeMic();
    refreshRecogModeLock();
    dbg('[SR] listening OFF'); // [DEBUG]
  }

  els.btnToggleMic?.addEventListener("click", ()=>{ if(!state.listening) startListening(); else stopListening(); });

  // ---------- 완료/자동이동 ----------
  async function advanceToNextVerse() {
    if (state.currentVerseIdx < state.verses.length - 1) {
      state.currentVerseIdx++;
      state.myStats.last.verse = state.currentVerseIdx + 1;
      saveLastPosition();
      updateVerseText();
      buildVerseGrid();
      dbg('[ADV] → next verse'); // [DEBUG]
      return true;
    }
    return false;
  }

  // ✅ 변경: force=true면 자동이동 체크박스 무시하고 이동
  async function completeVerse(force=false){
    await incVersesRead(1);
    markVerseAsDone(state.currentVerseIdx + 1);

    const auto = force ? true : (els.autoAdvance ? !!els.autoAdvance.checked : true);
    const b = getBookByKo(state.currentBookKo);

    if (auto){
      const moved = await advanceToNextVerse();
      if (!moved){
        await markChapterDone(b.id, state.currentChapter);

        if (state.currentChapter < b.ch) {
          const next = state.currentChapter + 1;
          await selectChapter(next);
          buildChapterGrid();
          state.paintedPrefix = 0;
          state.heardJ = "";
          state.ignoreUntilTs = Date.now() + 600;
          dbg('[ADV] → next chapter'); // [DEBUG]
        } else {
          alert("이 권의 모든 장을 완료했습니다. 다른 권을 선택하세요.");
          dbg('[ADV] book finished'); // [DEBUG]
        }
        return;
      }
      state.paintedPrefix = 0;
      state.heardJ = "";
      state.ignoreUntilTs = Date.now() + 500;
    } else {
      state.ignoreUntilTs = Date.now() + 300;
    }
  }

  // ---------- 앞/뒤 절 버튼 ----------
  els.btnNextVerse?.addEventListener("click", ()=>{
    if(!state.verses.length) return;
    if(state.currentVerseIdx<state.verses.length-1){
      state.currentVerseIdx++;
      state.myStats.last.verse = state.currentVerseIdx + 1;
      saveLastPosition();
      updateVerseText();
      buildVerseGrid();
      state.paintedPrefix=0; state.heardJ=""; state.ignoreUntilTs = Date.now() + 300;
      dbg('[UI] next verse click'); // [DEBUG]
    }
  });
  els.btnPrevVerse?.addEventListener("click", ()=>{
    if(!state.verses.length) return;
    if(state.currentVerseIdx>0){
      state.currentVerseIdx--;
      state.myStats.last.verse = state.currentVerseIdx + 1;
      saveLastPosition();
      updateVerseText();
      buildVerseGrid();
      state.paintedPrefix=0; state.heardJ=""; state.ignoreUntilTs = Date.now() + 300;
      dbg('[UI] prev verse click'); // [DEBUG]
    }
  });

  // "해당절읽음" 버튼
  els.btnMarkRead?.addEventListener("click", async () => {
    if (!state.verses.length) return;

    await incVersesRead(1);
    markVerseAsDone(state.currentVerseIdx + 1);

    if (state.currentVerseIdx < state.verses.length - 1) {
      state.currentVerseIdx++;
      state.myStats.last.verse = state.currentVerseIdx + 1;
      saveLastPosition();
      updateVerseText();
      buildVerseGrid();
      state.paintedPrefix = 0;
      state.heardJ = "";
      state.ignoreUntilTs = Date.now() + 500;
      dbg('[UI] mark-read → next'); // [DEBUG]
      return;
    }

    const b = getBookByKo(state.currentBookKo);
    await markChapterDone(b.id, state.currentChapter);
    state.myStats.last.verse = 0;
    state.myStats.last.chapter = state.currentChapter;
    saveLastPosition();

    if (state.currentChapter < b.ch) {
      const nextChapter = state.currentChapter + 1;
      await selectChapter(nextChapter);
      buildChapterGrid();
      state.paintedPrefix = 0;
      state.heardJ = "";
      state.ignoreUntilTs = Date.now() + 600;
      dbg('[UI] mark-read → next chapter'); // [DEBUG]
    } else {
      alert("이 권의 모든 장을 완료했습니다. 다른 권을 선택하세요.");
      dbg('[UI] mark-read → book finished'); // [DEBUG]
    }
  });

  // ---------- 음성모드 라디오: 마이크 ON일 때 변경 금지 ----------
  function refreshRecogModeLock() {
    const radios = document.querySelectorAll('input[name=recogMode]');
    if (!radios?.length) return;
    radios.forEach(r => { r.disabled = state.listening; });
  }
  document.querySelectorAll('input[name=recogMode]')?.forEach(radio=>{
    radio.addEventListener('change', (e)=>{
      if (state.listening) {
        e.preventDefault();
        e.stopImmediatePropagation();
        alert("마이크를 끈 후에 음성 인식 모드를 변경할 수 있습니다.");
        refreshRecogModeLock();
      }
    });
  });

  // ---------- Leaderboard ----------
  async function loadLeaderboard() {
    if (!db || !els.leaderList) return;
    let qs; try { qs = await db.collection("users").orderBy("versesRead","desc").limit(20).get(); } catch (e) { return; }
    const list=[]; qs.forEach(doc=>list.push({id:doc.id, ...doc.data()}));
    els.leaderList.innerHTML="";
    list.forEach((u,idx)=>{
      const label = (u.nickname && String(u.nickname).trim())
        ? String(u.nickname).trim()
        : ((u.email || "").toString().split("@")[0] || `user-${String(u.id).slice(0,6)}`);
      const v = Number(u.versesRead||0), c = Number(u.chaptersRead||0);
      const li=document.createElement("li");
      li.innerHTML = `<strong>${idx+1}위</strong> ${label} · 절 ${v.toLocaleString()} · 장 ${c.toLocaleString()}`;
      els.leaderList.appendChild(li);
    });
  }

  function shortBookName(b){
    return b.abbr || b.short || (b.ko ? b.ko.slice(0,2) : b.id || "");
  }

  // ---------- Progress Matrix ----------
  function buildMatrix() {
    if (!els.matrixWrap) return;
    const maxCh = Math.max(...BOOKS.map(b => b.ch));

    const table = document.createElement("table");
    table.className = "matrix";

    const thead = document.createElement("thead");

    const trTop    = document.createElement("tr");
    const trMiddle = document.createElement("tr");
    const trBottom = document.createElement("tr");

    const thBook = document.createElement("th");
    thBook.className = "book";
    thBook.textContent = "권/장";
    thBook.rowSpan = 3;
    trTop.appendChild(thBook);

    for (let c = 1; c <= maxCh; c++) {
      const hundreds = Math.floor(c / 100);
      const tens     = Math.floor((c % 100) / 10);
      const ones     = c % 10;

      const thH = document.createElement("th");
      thH.textContent = hundreds || "";
      const thT = document.createElement("th");
      thT.textContent = tens || "";
      const thO = document.createElement("th");
      thO.textContent = ones;

      [thH, thT, thO].forEach(th => {
        th.style.textAlign = "center";
        th.style.minWidth = "20px";
        th.style.width = "20px";
      });

      trTop.appendChild(thH);
      trMiddle.appendChild(thT);
      trBottom.appendChild(thO);
    }

    thead.appendChild(trTop);
    thead.appendChild(trMiddle);
    thead.appendChild(trBottom);
    table.appendChild(thead);

    const tbody = document.createElement("tbody");
    for (const b of BOOKS) {
      const tr = document.createElement("tr");

      const th = document.createElement("th");
      th.className = "book";
      th.textContent = shortBookName(b);
      tr.appendChild(th);

      const read = state.progress[b.id]?.readChapters || new Set();
      for (let c = 1; c <= maxCh; c++) {
        const td = document.createElement("td");
        if (c <= b.ch) {
          td.textContent = " ";
          td.style.background = read.has(c)
            ? "rgba(67,209,122,0.6)"
            : "rgba(120,120,140,0.25)";
          td.title = `${b.ko} ${c}장`;
        } else {
          td.style.background = "transparent";
        }
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }

    table.appendChild(tbody);
    els.matrixWrap.innerHTML = "";
    els.matrixWrap.appendChild(table);
  }

  function openMatrix(){
    buildMatrix();
    if (els.matrixModal){
      els.matrixModal.style.pointerEvents = "auto";
    }
    els.matrixModal?.classList.add("show");
    els.matrixModal?.classList.remove("hidden");
  }

  function closeMatrix(){
    els.matrixModal?.classList.remove("show");
    els.matrixModal?.classList.add("hidden");
    if (els.matrixModal){
      els.matrixModal.style.pointerEvents = "none";
    }
  }

  document.getElementById("btnOpenMatrix")?.addEventListener("click", openMatrix);
  els.btnCloseMatrix?.addEventListener("click", (e)=>{ e?.preventDefault?.(); e?.stopPropagation?.(); closeMatrix(); });
  els.matrixModal?.addEventListener("click", (e)=>{ const body=els.matrixModal.querySelector(".modal-body"); if (!body || !e.target) return; if (!body.contains(e.target)) closeMatrix(); });
  window.addEventListener("keydown", (e)=>{ if (e.key==='Escape' && els.matrixModal?.classList.contains('show')) closeMatrix(); });

  // ---------- Mic Level Meter ----------
  let audioCtx, analyser, micSrc, levelTimer, micStream;
  async function startMicLevel() {
    try {
      micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 256;
      micSrc = audioCtx.createMediaStreamSource(micStream);
      micSrc.connect(analyser);

      const dataArray = new Uint8Array(analyser.fftSize);

      function update() {
        if (!analyser) return;
        analyser.getByteTimeDomainData(dataArray);
        let sumSq = 0;
        for (let i = 0; i < dataArray.length; i++) {
          const v = (dataArray[i] - 128) / 128;
          sumSq += v * v;
        }
        const rms = Math.sqrt(sumSq / dataArray.length);
        const db = 20 * Math.log10(rms || 1e-6);
        if (els.micBar) els.micBar.style.width = Math.min(100, Math.max(0, rms * 400)) + "%";
        if (els.micDb) els.micDb.textContent = (db <= -60 ? "-∞" : db.toFixed(0)) + " dB";
        levelTimer = requestAnimationFrame(update);
      }
      update();
    } catch (e) {
      console.warn("[MicLevel] 마이크 접근 실패:", e);
    }
  }
  function stopMicLevel() {
    if (levelTimer) cancelAnimationFrame(levelTimer);
    levelTimer = null;
    if (audioCtx) { try { audioCtx.close(); } catch(_) {} }
    if (micStream) { try { micStream.getTracks().forEach(t=>t.stop()); } catch(_) {} }
    audioCtx = null; analyser = null; micSrc = null; micStream = null;
    if (els.micBar) els.micBar.style.width = "0%";
    if (els.micDb) els.micDb.textContent = "-∞ dB";
  }

  // ---------- 장 선택 ----------
  async function selectChapter(chapter) {
    state.currentChapter = chapter;
    state.currentVerseIdx = 0;

    const b = getBookByKo(state.currentBookKo);
    els.locLabel && (els.locLabel.textContent = `${b?.ko || ""} ${chapter}장`);
    els.verseText && (els.verseText.textContent = "로딩 중…");

    if (!state.bible) {
      await loadBible();
      if (!state.bible) {
        els.verseText && (els.verseText.textContent = "bible.json 로딩 실패");
        return;
      }
    }

    const chObj = state.bible?.[state.currentBookKo]?.[String(chapter)];
    if (!chObj) {
      els.verseText && (els.verseText.textContent = `${b?.ko || ""} ${chapter}장 본문 없음`);
      els.verseCount && (els.verseCount.textContent = "");
      els.verseGrid && (els.verseGrid.innerHTML = "");
      return;
    }

    const entries = Object.entries(chObj)
      .map(([k,v])=>[parseInt(k,10), String(v)])
      .sort((a,c)=>a[0]-c[0]);

    state.verses = entries.map(e=>e[1]);

    els.verseCount && (els.verseCount.textContent = `(${state.verses.length}절)`);
    buildVerseGrid();
    updateVerseText();

    state.myStats.last = { bookKo: state.currentBookKo, chapter, verse: 1 };
    saveLastPosition();

    buildChapterGrid();
    dbg(`[CH] select ${state.currentBookKo} ${chapter}`); // [DEBUG]
  }

})();
