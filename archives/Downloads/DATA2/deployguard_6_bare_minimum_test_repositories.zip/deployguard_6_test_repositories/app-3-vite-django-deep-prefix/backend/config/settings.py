SECRET_KEY = "deployguard-test-only"
DEBUG = False
ALLOWED_HOSTS = ["*"]
ROOT_URLCONF = "config.urls"
MIDDLEWARE = []
INSTALLED_APPS = ["rest_framework"]
REST_FRAMEWORK = {"UNAUTHENTICATED_USER": None}
DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"
