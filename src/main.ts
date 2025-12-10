import { bootstrapApplication } from '@angular/platform-browser';
import { provideHttpClient } from '@angular/common/http'; // ← Fix para HttpClient
import { App } from './app/app';


bootstrapApplication(App, {
  providers: [
    provideHttpClient(), // ← Proveedor para Transcribe service
  ]
}).catch(err => console.error(err));