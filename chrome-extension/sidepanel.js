import {createReviewView} from './view.mjs';
createReviewView().catch(error => { document.getElementById('message').textContent = error.message; });
