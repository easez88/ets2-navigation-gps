<script lang="ts" setup>
defineProps<{ width: number }>();
const selectedGame = defineModel<"ats" | "ets2" | null>();

const selectCard = (game: "ats" | "ets2" | null) => {
    selectedGame.value = game;
};
</script>

<template>
    <section class="game-select-section">
        <GameSelectButton
            game-name="ats"
            icon-name="map:route"
            :select-card="selectCard"
            :class="{ 'is-ats-selected': selectedGame === 'ats' }"
            :width="width"
        />
        <GameSelectButton
            :select-card="selectCard"
            game-name="ets2"
            icon-name="mdi:highway"
            :class="{ 'is-ets2-selected': selectedGame === 'ets2' }"
            :width="width"
        />
    </section>
</template>

<style
    lang="scss"
    scoped
    src="~/assets/scss/scoped/common/gameSelection.scss"
></style>
