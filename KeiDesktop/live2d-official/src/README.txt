# Kei Live2D src fixed set

Replace the matching files in:

D:\KeiDesktop\live2d-official\src\

Files included:
- lappdefine.ts
- lappdelegate.ts
- lappsubdelegate.ts
- lappview.ts
- lappmodel.ts
- lapplive2dmanager.ts
- main.ts

After replacement:

1. Keep the official Vite resource server running on http://localhost:5000
2. Run:
   cd D:\KeiDesktop\live2d-official
   npm run build
3. Restart Electron:
   cd D:\KeiDesktop
   npm start
4. In DevTools:
   window.KeiLive2D
   KeiLive2D.isReady()
   KeiLive2D.setMouth(1)
   KeiLive2D.setMouth(0)

Expected console logs:
- [Kei Live2D] bundle loaded
- [Kei Live2D] installing bridge
- [Kei Live2D] bridge installed
- [Kei Live2D] starting
- [Kei Live2D] Cubism canvas initialized
- [Kei Live2D] render loop started
